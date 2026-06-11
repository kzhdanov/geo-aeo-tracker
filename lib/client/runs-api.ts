"use client";

import type { ScrapeRun } from "@/components/dashboard/types";

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
