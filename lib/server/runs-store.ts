import { getServerSupabase } from "./supabase";

/**
 * Server-side access to the `runs` table. Mirrors the result contract of
 * lib/server/kv-store.ts: every function returns ok/error instead of throwing.
 */

export type RunRow = {
  id: string;
  workspace: string;
  created_at: string;
  provider: string;
  prompt: string;
  answer: string;
  sources: string[];
  visibility_score: number | null;
  sentiment: string | null;
  brand_mentions: string[] | null;
  competitor_mentions: string[] | null;
};

export type RunInsert = Omit<RunRow, "id" | "created_at"> & { created_at?: string };

export type RunsResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export async function listRuns(
  workspace: string,
  limit: number,
  offset: number,
): Promise<RunsResult<RunRow[]>> {
  const supabase = getServerSupabase();
  if (!supabase) return { ok: false, error: "cloud-not-configured" };

  const { data, error } = await supabase
    .from("runs")
    .select("*")
    .eq("workspace", workspace)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) return { ok: false, error: error.message };
  return { ok: true, value: (data ?? []) as RunRow[] };
}

export async function insertRuns(rows: RunInsert[]): Promise<RunsResult<RunRow[]>> {
  const supabase = getServerSupabase();
  if (!supabase) return { ok: false, error: "cloud-not-configured" };

  const { data, error } = await supabase.from("runs").insert(rows).select();

  if (error) return { ok: false, error: error.message };
  return { ok: true, value: (data ?? []) as RunRow[] };
}

export async function deleteRunById(id: string): Promise<RunsResult<null>> {
  const supabase = getServerSupabase();
  if (!supabase) return { ok: false, error: "cloud-not-configured" };

  const { error } = await supabase.from("runs").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  return { ok: true, value: null };
}

export async function deleteRunsByPrompt(
  workspace: string,
  prompt: string,
): Promise<RunsResult<null>> {
  const supabase = getServerSupabase();
  if (!supabase) return { ok: false, error: "cloud-not-configured" };

  const { error } = await supabase
    .from("runs")
    .delete()
    .eq("workspace", workspace)
    .eq("prompt", prompt);
  if (error) return { ok: false, error: error.message };
  return { ok: true, value: null };
}

export async function deleteRunsForWorkspace(workspace: string): Promise<RunsResult<null>> {
  const supabase = getServerSupabase();
  if (!supabase) return { ok: false, error: "cloud-not-configured" };

  const { error } = await supabase.from("runs").delete().eq("workspace", workspace);
  if (error) return { ok: false, error: error.message };
  return { ok: true, value: null };
}
