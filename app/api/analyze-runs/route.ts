import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isCloudStorageConfigured } from "@/lib/server/supabase";
import { getRunsByIds, listRuns, type RunRow } from "@/lib/server/runs-store";
import {
  insertAnalysis,
  listAnalysesForWorkspace,
  runIdsWithAnalysis,
  type RunAnalysisRow,
} from "@/lib/server/run-analyses-store";
import { kvGet } from "@/lib/server/kv-store";
import {
  judgeRun,
  resolveRubric,
  ANALYZER_ID,
  RUBRIC_VERSION,
  type JudgeEntity,
} from "@/lib/server/openrouter-judge";

// supabase-js + the OpenRouter fetch need the Node runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Judging a batch is several sequential LLM calls; give it room past the default.
export const maxDuration = 60;

const workspaceSchema = z.string().min(1).max(128);
const bodySchema = z.object({
  workspace: workspaceSchema,
  // Manual button: judge exactly these runs (always inserts a fresh verdict).
  // Omitted: batch — judge every workspace run that has no verdict yet.
  runIds: z.array(z.string().min(1).max(64)).max(500).optional(),
});

/**
 * Map a workspace id to its kv_store settings key. Mirrors
 * `storageKeyForWorkspace` in components/sovereign-dashboard.tsx — keep in sync.
 */
function settingsKey(workspace: string): string {
  return workspace === "default"
    ? "sovereign-aeo-tracker-v1"
    : `sovereign-aeo-tracker-${workspace}`;
}

/** Shape of the persisted AppState we actually read (brand + competitors only). */
type StoredState = {
  brand?: { brandName?: string; brandAliases?: string };
  competitors?: { name?: string; aliases?: string[] }[];
};

/** Tracked entities for the judge: own brand (+ aliases) and each competitor. */
function buildEntities(state: StoredState | null): {
  brand: JudgeEntity;
  competitors: JudgeEntity[];
} {
  const brandName = state?.brand?.brandName?.trim() || "the brand";
  const brandAliases = (state?.brand?.brandAliases ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const competitors = (state?.competitors ?? [])
    .filter((c): c is { name: string; aliases?: string[] } => Boolean(c?.name?.trim()))
    .map((c) => ({
      name: c.name.trim(),
      aliases: (c.aliases ?? []).map((a) => a.trim()).filter(Boolean),
    }));

  return { brand: { name: brandName, aliases: brandAliases }, competitors };
}

function notConfigured() {
  return NextResponse.json(
    { error: "Cloud storage is not configured on this deployment." },
    { status: 501 },
  );
}

/** Load saved verdicts for a workspace (hydrates the UI on mount + feeds charts). */
export async function GET(req: NextRequest) {
  if (!isCloudStorageConfigured()) return notConfigured();

  const workspace = workspaceSchema.safeParse(
    req.nextUrl.searchParams.get("workspace") ?? "default",
  );
  if (!workspace.success) {
    return NextResponse.json({ error: "Invalid `workspace` param." }, { status: 400 });
  }

  const res = await listAnalysesForWorkspace(workspace.data, ANALYZER_ID, RUBRIC_VERSION);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 500 });
  return NextResponse.json({ analyses: res.value });
}

export async function POST(req: NextRequest) {
  if (!isCloudStorageConfigured()) return notConfigured();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body: expected {workspace, runIds?: string[]}." },
      { status: 400 },
    );
  }
  const { workspace, runIds } = parsed.data;

  // 1. Tracked entities from the workspace's saved settings.
  const stateRes = await kvGet<StoredState>(settingsKey(workspace));
  if (!stateRes.ok) return NextResponse.json({ error: stateRes.error }, { status: 500 });
  const { brand, competitors } = buildEntities(stateRes.value);

  // 2. Resolve which runs to judge.
  let runs: RunRow[];
  if (runIds && runIds.length > 0) {
    // Manual path: judge exactly these, re-judging allowed (appends).
    const res = await getRunsByIds(workspace, runIds);
    if (!res.ok) return NextResponse.json({ error: res.error }, { status: 500 });
    runs = res.value;
  } else {
    // Batch path: every workspace run without a verdict for this analyzer+rubric.
    const all = await listRuns(workspace, 1000, 0);
    if (!all.ok) return NextResponse.json({ error: all.error }, { status: 500 });
    const seen = await runIdsWithAnalysis(
      all.value.map((r) => r.id),
      ANALYZER_ID,
      RUBRIC_VERSION,
    );
    if (!seen.ok) return NextResponse.json({ error: seen.error }, { status: 500 });
    runs = all.value.filter((r) => !seen.value.has(r.id));
  }

  if (runs.length === 0) {
    return NextResponse.json({ analyses: [], judged: 0, errors: [] });
  }

  // 3. Judge each run, persist the verdict. Bounded concurrency: a single request
  // may have to judge a whole batch (N prompts × M providers), and each judge is a
  // network LLM call. Running them in a pool of CONCURRENCY keeps wall-clock under
  // the function limit (maxDuration) instead of N × ~2s sequentially, while staying
  // gentle on the OpenRouter rate/cost. Each verdict is inserted the moment it's
  // ready, so a mid-flight cutoff still persists everything judged so far.
  const CONCURRENCY = 5;
  const analyses: RunAnalysisRow[] = [];
  const errors: { runId: string; error: string }[] = [];

  async function judgeAndStore(run: RunRow): Promise<void> {
    const rubric = resolveRubric(run.prompt_tags ?? []);
    const result = await judgeRun({
      rubric,
      prompt: run.prompt,
      answer: run.answer,
      sources: run.sources ?? [],
      brand,
      competitors,
    });
    if (!result.ok) {
      errors.push({ runId: run.id, error: result.error });
      return;
    }
    const ins = await insertAnalysis({
      run_id: run.id,
      analyzer: ANALYZER_ID,
      rubric_version: RUBRIC_VERSION,
      verdict: result.verdict,
    });
    if (!ins.ok) {
      errors.push({ runId: run.id, error: ins.error });
      return;
    }
    analyses.push(ins.value);
  }

  // Worker pool: each worker pulls the next run off a shared cursor until drained.
  // `cursor++` is safe — increments run synchronously between awaits on one thread.
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < runs.length) {
      await judgeAndStore(runs[cursor++]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, runs.length) }, worker),
  );

  return NextResponse.json({ analyses, judged: analyses.length, errors });
}
