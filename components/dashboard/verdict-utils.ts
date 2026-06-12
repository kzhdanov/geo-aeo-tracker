import type { ScrapeRun, Provider } from "@/components/dashboard/types";
import type { JudgeVerdict } from "@/lib/server/openrouter-judge";

/**
 * Shared helpers for displaying LLM-judge verdicts. Pure + client-safe — used by
 * both the Responses tab (per-run pills/panel) and the Brand Reputation tab (chart).
 */

/** Tailwind text-color class for a 0–100 judge score. */
export function scoreColor(score: number): string {
  return score >= 60 ? "text-th-success" : score >= 30 ? "text-th-text-accent" : "text-th-danger";
}

/** Headline score for a verdict: the brand's score, or 0 when the brand can't be identified. */
export function headlineScore(verdict: JudgeVerdict, brandTerms: string[]): number {
  const terms = brandTerms.map((t) => t.toLowerCase());
  const brand = Object.entries(verdict.entities).find(([name]) => terms.includes(name.toLowerCase()));
  // No brand match → the brand isn't configured for this workspace. Return 0 rather
  // than the max over all entities, which would surface a *competitor's* score as the
  // brand headline (green "great reputation" when your brand wasn't even mentioned).
  return brand ? brand[1].score ?? 0 : 0;
}

export function shortHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url.length > 30 ? url.slice(0, 30) + "…" : url;
  }
}

export type ReputationRow = { day: string; [provider: string]: string | number | null };

/** Local "MM-DD HH:mm" label for a chart x-point (date + time down to the minute). */
function formatBucketLabel(t: number): string {
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Build the "score over time" series for one prompt: one row per minute-bucket, one
 * column per provider (provider enum value as the key). Only runs that have a verdict
 * are included; a re-judged run uses its latest verdict (the bucket's last run wins).
 * Scores stay comparable because a single prompt has a single rubric.
 */
export function buildReputationSeries(
  runs: ScrapeRun[],
  verdicts: Record<string, JudgeVerdict>,
  prompt: string,
  brandTerms: string[],
): { rows: ReputationRow[]; providers: Provider[] } {
  const judged = runs.filter((r) => r.prompt === prompt && r.id && verdicts[r.id]);
  if (judged.length === 0) return { rows: [], providers: [] };

  // minute-bucket -> { t, provider -> { score, t } } keeping the latest run that minute per provider.
  // Bucketing by minute (not day) spreads same-day runs into distinct points instead of collapsing them.
  const byBucket = new Map<string, { t: number; scores: Map<Provider, { score: number; t: number }> }>();
  const providers = new Set<Provider>();

  for (const run of judged) {
    const t = new Date(run.createdAt).getTime();
    const bucketKey = run.createdAt.slice(0, 16); // "YYYY-MM-DDTHH:mm" — minute resolution, sortable as a string
    const score = headlineScore(verdicts[run.id!], brandTerms);
    providers.add(run.provider);
    const bucket = byBucket.get(bucketKey) ?? { t, scores: new Map<Provider, { score: number; t: number }>() };
    bucket.t = Math.max(bucket.t, t);
    const prev = bucket.scores.get(run.provider);
    if (!prev || t >= prev.t) bucket.scores.set(run.provider, { score, t });
    byBucket.set(bucketKey, bucket);
  }

  const rows: ReputationRow[] = [...byBucket.values()]
    .sort((a, b) => a.t - b.t)
    .map((bucket) => {
      const row: ReputationRow = { day: formatBucketLabel(bucket.t) };
      for (const p of providers) row[p] = bucket.scores.get(p)?.score ?? null;
      return row;
    });

  return { rows, providers: [...providers] };
}
