import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isCloudStorageConfigured } from "@/lib/server/supabase";
import {
  deleteRunById,
  deleteRunsByPrompt,
  deleteRunsForWorkspace,
  insertRuns,
  listRuns,
  type RunInsert,
  type RunRow,
} from "@/lib/server/runs-store";

// supabase-js requires Node APIs — stay on the Node runtime.
export const runtime = "nodejs";
// Run mutations should always read the latest rows; opt out of caching.
export const dynamic = "force-dynamic";

const workspaceSchema = z.string().min(1).max(128);

const runSchema = z.object({
  provider: z.string().min(1).max(64),
  prompt: z.string().min(1),
  answer: z.string(),
  sources: z.array(z.string()).default([]),
  promptTags: z.array(z.string()).default([]),
  createdAt: z.string().optional(),
  visibilityScore: z.number().nullish(),
  sentiment: z.string().nullish(),
  brandMentions: z.array(z.string()).nullish(),
  competitorMentions: z.array(z.string()).nullish(),
});

const postBodySchema = z.object({
  workspace: workspaceSchema,
  runs: z.array(runSchema).min(1).max(500),
});

type ClientRun = z.infer<typeof runSchema> & { id: string };

function toClient(row: RunRow): ClientRun {
  return {
    id: row.id,
    provider: row.provider,
    prompt: row.prompt,
    answer: row.answer,
    sources: row.sources ?? [],
    promptTags: row.prompt_tags ?? [],
    createdAt: row.created_at,
    visibilityScore: row.visibility_score,
    sentiment: row.sentiment,
    brandMentions: row.brand_mentions ?? [],
    competitorMentions: row.competitor_mentions ?? [],
  };
}

function toRow(workspace: string, run: z.infer<typeof runSchema>): RunInsert {
  return {
    workspace,
    provider: run.provider,
    prompt: run.prompt,
    answer: run.answer,
    sources: run.sources,
    prompt_tags: run.promptTags,
    ...(run.createdAt ? { created_at: run.createdAt } : {}),
    visibility_score: run.visibilityScore ?? null,
    sentiment: run.sentiment ?? null,
    brand_mentions: run.brandMentions ?? null,
    competitor_mentions: run.competitorMentions ?? null,
  };
}

function notConfigured() {
  return NextResponse.json(
    { error: "Cloud storage is not configured on this deployment." },
    { status: 501 },
  );
}

export async function GET(req: NextRequest) {
  if (!isCloudStorageConfigured()) return notConfigured();

  const params = req.nextUrl.searchParams;
  const workspace = workspaceSchema.safeParse(params.get("workspace") ?? "default");
  if (!workspace.success) {
    return NextResponse.json({ error: "Invalid `workspace` param." }, { status: 400 });
  }
  const limit = Math.min(Math.max(Number(params.get("limit") ?? 500) || 500, 1), 1000);
  const offset = Math.max(Number(params.get("offset") ?? 0) || 0, 0);

  const res = await listRuns(workspace.data, limit, offset);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 500 });
  return NextResponse.json({ runs: res.value.map(toClient) });
}

export async function POST(req: NextRequest) {
  if (!isCloudStorageConfigured()) return notConfigured();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const parsed = postBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body: expected {workspace, runs: [...]}." },
      { status: 400 },
    );
  }

  const rows = parsed.data.runs.map((run) => toRow(parsed.data.workspace, run));
  const res = await insertRuns(rows);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 500 });
  return NextResponse.json({ runs: res.value.map(toClient) });
}

export async function DELETE(req: NextRequest) {
  if (!isCloudStorageConfigured()) return notConfigured();

  const params = req.nextUrl.searchParams;
  const id = params.get("id");
  if (id) {
    const res = await deleteRunById(id);
    if (!res.ok) return NextResponse.json({ error: res.error }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  const workspace = workspaceSchema.safeParse(params.get("workspace"));
  if (!workspace.success) {
    return NextResponse.json(
      { error: "Provide `id`, or `workspace` with `prompt`/`all=true`." },
      { status: 400 },
    );
  }

  const prompt = params.get("prompt");
  if (prompt) {
    const res = await deleteRunsByPrompt(workspace.data, prompt);
    if (!res.ok) return NextResponse.json({ error: res.error }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  if (params.get("all") === "true") {
    const res = await deleteRunsForWorkspace(workspace.data);
    if (!res.ok) return NextResponse.json({ error: res.error }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json(
    { error: "Provide `id`, or `workspace` with `prompt`/`all=true`." },
    { status: 400 },
  );
}
