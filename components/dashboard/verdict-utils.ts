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

/**
 * Build the "score over time" series for one prompt: one row per day, one column
 * per provider (provider enum value as the key). Only runs that have a verdict
 * are included; a re-judged run uses its latest verdict (the day's last run wins).
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

  // day -> provider -> { score, t } keeping the latest run that day per provider.
  const byDay = new Map<string, Map<Provider, { score: number; t: number }>>();
  const providers = new Set<Provider>();

  for (const run of judged) {
    const day = run.createdAt.slice(0, 10);
    const t = new Date(run.createdAt).getTime();
    const score = headlineScore(verdicts[run.id!], brandTerms);
    providers.add(run.provider);
    const dayMap = byDay.get(day) ?? new Map<Provider, { score: number; t: number }>();
    const prev = dayMap.get(run.provider);
    if (!prev || t >= prev.t) dayMap.set(run.provider, { score, t });
    byDay.set(day, dayMap);
  }

  const rows: ReputationRow[] = [...byDay.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([day, dayMap]) => {
      const row: ReputationRow = { day };
      for (const p of providers) row[p] = dayMap.get(p)?.score ?? null;
      return row;
    });

  return { rows, providers: [...providers] };
}
