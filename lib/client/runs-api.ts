"use client";

import type { ScrapeRun } from "@/components/dashboard/types";
import type { JudgeVerdict } from "@/lib/server/openrouter-judge";

/**
 * Client wrapper for /api/runs. Each run lives as its own row in the
 * Supabase `runs` table; the dashboard keeps a working copy in React state.
 * All functions throw on failure so callers can surface errors in the UI.
 */

export async function fetchRuns(workspace: string, limit = 500): Promise<ScrapeRun[]> {
  const res = await fetch(
    `/api/runs?workspace=${encodeURIComponent(workspace)}&limit=${limit}`,
    { cache: "no-store" },
  );
  if (!res.ok) throw new Error(`runs GET failed: ${res.status}`);
  const data = (await res.json()) as { runs: ScrapeRun[] };
  return data.runs;
}

/** Insert runs and return them with server-assigned ids (newest first). */
export async function persistRuns(workspace: string, runs: ScrapeRun[]): Promise<ScrapeRun[]> {
  if (runs.length === 0) return [];
  const res = await fetch("/api/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspace, runs }),
  });
  if (!res.ok) throw new Error(`runs POST failed: ${res.status}`);
  const data = (await res.json()) as { runs: ScrapeRun[] };
  return data.runs;
}

/** One stored verdict row (mirror of run_analyses). */
export type RunAnalysis = {
  id: string;
  run_id: string;
  analyzer: string;
  rubric_version: string;
  verdict: JudgeVerdict;
  created_at: string;
};

type AnalyzeResponse = {
  analyses: RunAnalysis[];
  judged: number;
  errors: { runId: string; error: string }[];
};

/** POST runs to the judge. Shared by analyzeRun/analyzeRuns; throws on transport failure. */
async function postAnalyze(workspace: string, runIds: string[]): Promise<AnalyzeResponse> {
  const res = await fetch("/api/analyze-runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspace, runIds }),
  });
  if (!res.ok) throw new Error(`analyze-runs failed: ${res.status}`);
  return (await res.json()) as AnalyzeResponse;
}

/**
 * Judge a single run (manual "Launch the judge" button). Always appends a fresh
 * verdict row, so re-clicking re-scores rather than returning a cached result.
 * Returns the new verdict; throws with the judge's error message on failure.
 */
export async function analyzeRun(workspace: string, runId: string): Promise<RunAnalysis> {
  const data = await postAnalyze(workspace, [runId]);
  if (data.analyses.length > 0) return data.analyses[0];
  throw new Error(data.errors[0]?.error ?? "Judge returned no verdict.");
}

/** Load saved verdicts for a workspace (oldest first). Used to hydrate on mount. */
export async function fetchAnalyses(workspace: string): Promise<RunAnalysis[]> {
  const res = await fetch(
    `/api/analyze-runs?workspace=${encodeURIComponent(workspace)}`,
    { cache: "no-store" },
  );
  if (!res.ok) throw new Error(`analyses GET failed: ${res.status}`);
  const data = (await res.json()) as { analyses: RunAnalysis[] };
  return data.analyses;
}

/**
 * Judge several runs at once (used by the auto-trigger after a batch run).
 * Returns the verdict rows that succeeded; failures are reported in the
 * response's `errors` and simply omitted here. Throws only on transport failure.
 */
export async function analyzeRuns(workspace: string, runIds: string[]): Promise<RunAnalysis[]> {
  if (runIds.length === 0) return [];
  const data = await postAnalyze(workspace, runIds);
  return data.analyses;
}

export async function deleteRun(id: string): Promise<void> {
  const res = await fetch(`/api/runs?id=${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`runs DELETE failed: ${res.status}`);
}

export async function deleteRunsByPrompt(workspace: string, prompt: string): Promise<void> {
  const res = await fetch(
    `/api/runs?workspace=${encodeURIComponent(workspace)}&prompt=${encodeURIComponent(prompt)}`,
    { method: "DELETE" },
  );
  if (!res.ok) throw new Error(`runs DELETE failed: ${res.status}`);
}

export async function deleteRunsForWorkspace(workspace: string): Promise<void> {
  const res = await fetch(
    `/api/runs?workspace=${encodeURIComponent(workspace)}&all=true`,
    { method: "DELETE" },
  );
  if (!res.ok) throw new Error(`runs DELETE failed: ${res.status}`);
}
