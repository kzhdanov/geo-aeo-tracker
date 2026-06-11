"use client";

/**
 * Cloud-backed storage for the geo-aeo-tracker app.
 *
 * Supabase (via the /api/state route) is the single source of truth.
 * There is intentionally no local fallback: serving a stale local copy and
 * autosaving it back silently rolls back newer cloud data. Errors propagate
 * to callers so the UI can surface them instead.
 */

export async function loadSovereignValue<T>(key: string, fallback: T): Promise<T> {
  const res = await fetch(`/api/state?key=${encodeURIComponent(key)}`, {
    method: "GET",
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`cloud GET failed: ${res.status}`);
  const data = (await res.json()) as { value: T | null };
  return data.value ?? fallback;
}

export async function saveSovereignValue<T>(key: string, value: T): Promise<void> {
  const res = await fetch(`/api/state`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, value }),
  });
  if (!res.ok) throw new Error(`cloud PUT failed: ${res.status}`);
}

export async function clearSovereignStore(key: string): Promise<void> {
  const res = await fetch(`/api/state?key=${encodeURIComponent(key)}`, {
    method: "DELETE",
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`cloud DELETE failed: ${res.status}`);
  }
}
