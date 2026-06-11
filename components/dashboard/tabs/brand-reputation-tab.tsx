import { useMemo, useState } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { ScrapeRun, Provider } from "@/components/dashboard/types";
import { PROVIDER_LABELS } from "@/components/dashboard/types";
import type { JudgeVerdict } from "@/lib/server/openrouter-judge";
import { buildReputationSeries, headlineScore, scoreColor, shortHost } from "@/components/dashboard/verdict-utils";

type BrandReputationTabProps = {
  runs: ScrapeRun[];
  /** Latest verdict per run id (shared with Responses; filled by judge button + auto-trigger). */
  verdicts: Record<string, JudgeVerdict>;
  brandTerms: string[];
};

const PROVIDER_COLORS: Record<Provider, string> = {
  chatgpt: "#10a37f",
  perplexity: "#1ba1e3",
  copilot: "#7c5bbf",
  gemini: "#4285f4",
  google_ai: "#ea4335",
  grok: "#6b7280",
};

export function BrandReputationTab({ runs, verdicts, brandTerms }: BrandReputationTabProps) {
  // Prompts that have at least one judged run, with their rubric (verdicts carry it).
  const judgedPrompts = useMemo(() => {
    const m = new Map<string, "brand" | "discovery">();
    for (const r of runs) {
      if (r.id && verdicts[r.id] && !m.has(r.prompt)) m.set(r.prompt, verdicts[r.id].rubric);
    }
    return [...m.entries()].map(([prompt, rubric]) => ({ prompt, rubric }));
  }, [runs, verdicts]);

  const [selected, setSelected] = useState<string>("");
  const prompt = selected && judgedPrompts.some((p) => p.prompt === selected)
    ? selected
    : judgedPrompts[0]?.prompt ?? "";
  const rubric = judgedPrompts.find((p) => p.prompt === prompt)?.rubric;

  const { rows, providers } = useMemo(
    () => buildReputationSeries(runs, verdicts, prompt, brandTerms),
    [runs, verdicts, prompt, brandTerms],
  );

  // Per-provider current score + delta vs the previous judged run for this prompt.
  const snapshots = useMemo(() => {
    const byProvider = new Map<Provider, { score: number; t: number }[]>();
    for (const r of runs) {
      if (r.prompt !== prompt || !r.id || !verdicts[r.id]) continue;
      const arr = byProvider.get(r.provider) ?? [];
      arr.push({ score: headlineScore(verdicts[r.id], brandTerms), t: new Date(r.createdAt).getTime() });
      byProvider.set(r.provider, arr);
    }
    return [...byProvider.entries()]
      .map(([provider, arr]) => {
        arr.sort((a, b) => a.t - b.t);
        const current = arr[arr.length - 1].score;
        const prev = arr.length >= 2 ? arr[arr.length - 2].score : null;
        return { provider, current, delta: prev == null ? null : current - prev, points: arr.length };
      })
      .sort((a, b) => b.current - a.current);
  }, [runs, verdicts, prompt, brandTerms]);

  // Recurring negatives: claims (exact text) + negative sources (by host), across this prompt's verdicts.
  const negatives = useMemo(() => {
    const claims = new Map<string, number>();
    const sources = new Map<string, number>();
    for (const r of runs) {
      if (r.prompt !== prompt || !r.id || !verdicts[r.id]) continue;
      for (const e of Object.values(verdicts[r.id].entities)) {
        for (const c of e.claims_negative) claims.set(c, (claims.get(c) ?? 0) + 1);
        for (const s of e.negative_sources) {
          const host = shortHost(s);
          sources.set(host, (sources.get(host) ?? 0) + 1);
        }
      }
    }
    const top = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    return { claims: top(claims), sources: top(sources) };
  }, [runs, verdicts, prompt]);

  if (judgedPrompts.length === 0) {
    return (
      <div className="rounded-lg border border-th-border bg-th-card-alt p-8 text-center">
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-th-accent-soft text-th-text-accent text-xl">
          ⚖
        </div>
        <p className="text-sm font-medium text-th-text">No judge verdicts yet</p>
        <p className="mx-auto mt-1 max-w-md text-sm text-th-text-secondary">
          Run prompts (new runs are scored automatically) or click <strong>Launch the judge</strong> on a
          response. The reputation trend builds as verdicts accumulate over time.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Prompt selector + rubric */}
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-th-border bg-th-card px-3 py-2.5">
        <span className="text-xs font-medium text-th-text-muted">Prompt:</span>
        <select
          value={prompt}
          onChange={(e) => setSelected(e.target.value)}
          className="bd-input min-w-0 max-w-[420px] flex-1 truncate rounded-lg px-2.5 py-1.5 text-xs"
        >
          {judgedPrompts.map((p) => (
            <option key={p.prompt} value={p.prompt}>
              {p.prompt.length > 80 ? p.prompt.slice(0, 77) + "…" : p.prompt}
            </option>
          ))}
        </select>
        {rubric && (
          <span className="rounded-full border border-th-border bg-th-card-alt px-2 py-0.5 text-[10px] uppercase text-th-text-muted">
            {rubric}
          </span>
        )}
        <span className="ml-auto text-[10px] text-th-text-muted">
          judge score · 0–100 · compare within one rubric
        </span>
      </div>

      {/* Score-over-time chart */}
      <div className="rounded-xl border border-th-border bg-th-card p-3">
        <div className="mb-2 text-xs font-medium uppercase tracking-wider text-th-text-muted">
          Score over time — by model
        </div>
        {rows.length === 0 ? (
          <p className="px-2 py-8 text-center text-sm text-th-text-muted">No data points for this prompt yet.</p>
        ) : (
          <div className="h-80 w-full">
            <ResponsiveContainer>
              <LineChart data={rows}>
                <CartesianGrid stroke="var(--th-chart-grid)" strokeDasharray="3 3" />
                <XAxis dataKey="day" tick={{ fill: "var(--th-chart-axis)", fontSize: 12 }} />
                <YAxis domain={[0, 100]} tick={{ fill: "var(--th-chart-axis)", fontSize: 12 }} />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "var(--th-card)",
                    border: "1px solid var(--th-border)",
                    borderRadius: "8px",
                    color: "var(--th-text)",
                  }}
                />
                <Legend />
                {providers.map((p) => (
                  <Line
                    key={p}
                    type="monotone"
                    dataKey={p}
                    name={PROVIDER_LABELS[p] ?? p}
                    stroke={PROVIDER_COLORS[p] ?? "var(--th-accent)"}
                    strokeWidth={2.5}
                    dot={{ r: 3 }}
                    connectNulls
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* Current snapshot + delta per model */}
      {snapshots.length > 0 && (
        <div className="rounded-xl border border-th-border bg-th-card p-3">
          <div className="mb-2 text-xs font-medium uppercase tracking-wider text-th-text-muted">
            Latest score + change vs previous run
          </div>
          <div className="flex flex-wrap gap-2">
            {snapshots.map(({ provider, current, delta }) => (
              <div
                key={provider}
                className="flex items-center gap-2 rounded-lg border border-th-border bg-th-card-alt px-3 py-1.5"
              >
                <span
                  className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold"
                  style={{
                    backgroundColor: (PROVIDER_COLORS[provider] ?? "#4285f4") + "22",
                    color: PROVIDER_COLORS[provider] ?? "#4285f4",
                  }}
                >
                  {PROVIDER_LABELS[provider] ?? provider}
                </span>
                <span className={`text-sm font-bold ${scoreColor(current)}`}>{current}</span>
                <span className="text-xs text-th-text-muted">/100</span>
                {delta != null && delta !== 0 && (
                  <span
                    className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-xs font-bold ${
                      delta > 0 ? "bg-th-success-soft text-th-success" : "bg-th-danger-soft text-th-danger"
                    }`}
                  >
                    {delta > 0 ? "↑" : "↓"}{Math.abs(delta)}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recurring negatives */}
      {(negatives.claims.length > 0 || negatives.sources.length > 0) && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl border border-th-border bg-th-card p-3">
            <div className="mb-2 text-xs font-medium uppercase tracking-wider text-th-text-muted">
              Recurring criticisms
            </div>
            {negatives.claims.length === 0 ? (
              <p className="text-xs text-th-text-muted">None raised.</p>
            ) : (
              <ul className="space-y-1">
                {negatives.claims.map(([claim, n]) => (
                  <li key={claim} className="flex items-start gap-2 text-xs text-th-text-secondary">
                    {n > 1 && (
                      <span className="mt-0.5 shrink-0 rounded-full bg-th-danger-soft px-1.5 text-[10px] font-bold text-th-danger">
                        ×{n}
                      </span>
                    )}
                    <span>{claim}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="rounded-xl border border-th-border bg-th-card p-3">
            <div className="mb-2 text-xs font-medium uppercase tracking-wider text-th-text-muted">
              Negative sources cited
            </div>
            {negatives.sources.length === 0 ? (
              <p className="text-xs text-th-text-muted">None cited.</p>
            ) : (
              <ul className="space-y-1">
                {negatives.sources.map(([host, n]) => (
                  <li key={host} className="flex items-center gap-2 text-xs">
                    {n > 1 && (
                      <span className="shrink-0 rounded-full bg-th-danger-soft px-1.5 text-[10px] font-bold text-th-danger">
                        ×{n}
                      </span>
                    )}
                    <span className="text-th-danger">{host}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
