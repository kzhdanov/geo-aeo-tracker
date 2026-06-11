import { getServerSupabase } from "./supabase";
import type { JudgeVerdict } from "./openrouter-judge";

/**
 * Server-side access to the `run_analyses` table (one judge verdict per row).
 * Mirrors the ok/error contract of runs-store.ts / kv-store.ts.
 *
 * Since migration 004 there is NO unique(run_id, analyzer, rubric_version):
 * a run may carry several verdicts (manual re-judging appends). Idempotency for
 * the automatic path is enforced here via `runIdsWithAnalysis` — the analyze-runs
 * route skips runs that already have a verdict for the current analyzer+rubric.
 */

export type RunAnalysisRow = {
  id: string;
  run_id: string;
  analyzer: string;
  rubric_version: string;
  verdict: JudgeVerdict;
  created_at: string;
};

export type RunAnalysisInsert = {
  run_id: string;
  analyzer: string;
  rubric_version: string;
  verdict: JudgeVerdict;
};

export type AnalysesResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export async function insertAnalysis(
  row: RunAnalysisInsert,
): Promise<AnalysesResult<RunAnalysisRow>> {
  const supabase = getServerSupabase();
  if (!supabase) return { ok: false, error: "cloud-not-configured" };

  const { data, error } = await supabase
    .from("run_analyses")
    .insert(row)
    .select()
    .single();

  if (error) return { ok: false, error: error.message };
  return { ok: true, value: data as RunAnalysisRow };
}

/**
 * All verdicts for a workspace's runs (for the current analyzer+rubric), oldest
 * first. Joins through the run_id → runs FK to filter by workspace. The caller
 * reduces to latest-per-run for the "current" view; the full list feeds charts.
 */
export async function listAnalysesForWorkspace(
  workspace: string,
  analyzer: string,
  rubricVersion: string,
): Promise<AnalysesResult<RunAnalysisRow[]>> {
  const supabase = getServerSupabase();
  if (!supabase) return { ok: false, error: "cloud-not-configured" };

  const { data, error } = await supabase
    .from("run_analyses")
    .select("id, run_id, analyzer, rubric_version, verdict, created_at, runs!inner(workspace)")
    .eq("runs.workspace", workspace)
    .eq("analyzer", analyzer)
    .eq("rubric_version", rubricVersion)
    .order("created_at", { ascending: true });

  if (error) return { ok: false, error: error.message };
  // Strip the joined `runs` helper column; callers want plain RunAnalysisRow.
  const rows = (data ?? []).map((row) => {
    const r = row as RunAnalysisRow & { runs?: unknown };
    delete r.runs;
    return r as RunAnalysisRow;
  });
  return { ok: true, value: rows };
}

/** Run ids that already have a verdict for this analyzer+rubric (auto-path idempotency). */
export async function runIdsWithAnalysis(
  runIds: string[],
  analyzer: string,
  rubricVersion: string,
): Promise<AnalysesResult<Set<string>>> {
  const supabase = getServerSupabase();
  if (!supabase) return { ok: false, error: "cloud-not-configured" };
  if (runIds.length === 0) return { ok: true, value: new Set() };

  const { data, error } = await supabase
    .from("run_analyses")
    .select("run_id")
    .in("run_id", runIds)
    .eq("analyzer", analyzer)
    .eq("rubric_version", rubricVersion);

  if (error) return { ok: false, error: error.message };
  return { ok: true, value: new Set((data ?? []).map((r) => r.run_id as string)) };
}
