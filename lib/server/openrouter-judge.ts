/**
 * Brand-eval judge (LLM-as-judge). Reads one provider answer (a `runs` row) and
 * scores how it portrays the tracked brand + competitors, on a tag-driven rubric.
 *
 * Roles (see docs/brand-eval-plan.md):
 *   - provider (ChatGPT, Google AI) = the subject being monitored; its answer is the input
 *   - this module = the judge; its output is a `run_analyses.verdict`
 *   - entities (own brand + competitors) = what we track inside the answer
 *
 * The judge model is FROZEN: changing it would break the time series, so it is
 * recorded verbatim in `run_analyses.analyzer`. The numeric 0-100 score is NOT
 * asked of the model — the model only emits discrete labels, and the formula here
 * maps labels -> score. The formula is part of RUBRIC_VERSION; bump it to change weights.
 */

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const JUDGE_MODEL = "google/gemini-2.5-flash-lite";
const MAX_ANSWER_CHARS = 20_000;

/** Recorded in run_analyses.analyzer — provenance of the verdict. */
export const ANALYZER_ID = `openrouter:${JUDGE_MODEL}`;
/** Recorded in run_analyses.rubric_version — covers axes, labels AND the score formula. */
export const RUBRIC_VERSION = "v1";

/** Rubric tags recognized on a prompt, in priority order. */
const RUBRIC_TAGS = ["brand", "discovery"] as const;
export type JudgeRubric = (typeof RUBRIC_TAGS)[number];
const DEFAULT_RUBRIC: JudgeRubric = "discovery";

export type JudgeEntity = {
  /** Canonical display name, e.g. "pdfFiller" — verdict entities are keyed by this. */
  name: string;
  /** Other spellings the answer might use. */
  aliases: string[];
};

export type JudgeInput = {
  rubric: JudgeRubric;
  prompt: string;
  answer: string;
  sources: string[];
  brand: JudgeEntity;
  competitors: JudgeEntity[];
};

// --- label vocabularies + label->points (the rubric formula, frozen by RUBRIC_VERSION) ---

const BRAND_VERDICT = ["warned_against", "depends", "mild_yes", "clear_yes"] as const;
const BRAND_SENTIMENT = ["negative", "mixed", "neutral", "positive"] as const;
const BRAND_VERDICT_POINTS: Record<(typeof BRAND_VERDICT)[number], number> = {
  warned_against: 0,
  depends: 25,
  mild_yes: 42,
  clear_yes: 60,
};
const BRAND_SENTIMENT_POINTS: Record<(typeof BRAND_SENTIMENT)[number], number> = {
  negative: 0,
  mixed: 15,
  neutral: 25,
  positive: 40,
};

const DISCOVERY_PRESENCE = ["not_mentioned", "mentioned", "listed", "featured"] as const;
const DISCOVERY_RANK = ["not_listed", "bottom", "middle", "top"] as const;
const DISCOVERY_SENTIMENT = ["negative", "neutral", "positive"] as const;
const DISCOVERY_PRESENCE_POINTS: Record<(typeof DISCOVERY_PRESENCE)[number], number> = {
  not_mentioned: 0,
  mentioned: 20,
  listed: 35,
  featured: 50,
};
const DISCOVERY_RANK_POINTS: Record<(typeof DISCOVERY_RANK)[number], number> = {
  not_listed: 0,
  bottom: 8,
  middle: 16,
  top: 25,
};
const DISCOVERY_SENTIMENT_POINTS: Record<(typeof DISCOVERY_SENTIMENT)[number], number> = {
  negative: 0,
  neutral: 12,
  positive: 25,
};

export type BrandEntityVerdict = {
  mentioned: boolean;
  verdict: (typeof BRAND_VERDICT)[number];
  sentiment: (typeof BRAND_SENTIMENT)[number];
  score: number;
  claims_positive: string[];
  claims_negative: string[];
  negative_sources: string[];
  rationale: string;
};

export type DiscoveryEntityVerdict = {
  presence: (typeof DISCOVERY_PRESENCE)[number];
  rank: (typeof DISCOVERY_RANK)[number];
  sentiment: (typeof DISCOVERY_SENTIMENT)[number];
  score: number;
  claims_positive: string[];
  claims_negative: string[];
  negative_sources: string[];
  rationale: string;
};

export type JudgeVerdict =
  | { rubric: "brand"; entities: Record<string, BrandEntityVerdict>; summary: string }
  | { rubric: "discovery"; entities: Record<string, DiscoveryEntityVerdict>; summary: string };

export type JudgeResult =
  | { ok: true; verdict: JudgeVerdict }
  | { ok: false; error: string };

// --- formulas ---

function scoreBrand(v: BrandEntityVerdict): number {
  if (!v.mentioned) return 0;
  return BRAND_VERDICT_POINTS[v.verdict] + BRAND_SENTIMENT_POINTS[v.sentiment];
}

function scoreDiscovery(v: DiscoveryEntityVerdict): number {
  if (v.presence === "not_mentioned") return 0;
  return (
    DISCOVERY_PRESENCE_POINTS[v.presence] +
    DISCOVERY_RANK_POINTS[v.rank] +
    DISCOVERY_SENTIMENT_POINTS[v.sentiment]
  );
}

/** Pick the rubric for a prompt from its tags; first recognized tag wins, else default. */
export function resolveRubric(tags: string[]): JudgeRubric {
  for (const tag of tags) {
    if ((RUBRIC_TAGS as readonly string[]).includes(tag)) return tag as JudgeRubric;
  }
  return DEFAULT_RUBRIC;
}

// --- prompt building ---

function entityList(input: JudgeInput): JudgeEntity[] {
  return [input.brand, ...input.competitors];
}

function formatEntities(entities: JudgeEntity[]): string {
  return entities
    .map((e) =>
      e.aliases.length > 0
        ? `  - ${e.name} (aliases: ${e.aliases.join(", ")})`
        : `  - ${e.name}`,
    )
    .join("\n");
}

function brandSystemPrompt(entities: JudgeEntity[]): string {
  return `You are a brand-reputation analyst. You read an AI assistant's answer to a user's question and judge how that answer portrays specific brands. You do NOT answer the user's question yourself — you only assess what the answer says.

This question is ABOUT a specific brand (e.g. "is X worth it / safe / good"). For each tracked entity, classify:

- "mentioned": true if the entity is actually discussed in the answer, false otherwise.
- "verdict": the answer's bottom-line stance on the entity:
    "clear_yes"      = clearly endorses / recommends it
    "mild_yes"       = leans positive, with caveats
    "depends"        = genuinely mixed / "it depends"
    "warned_against" = recommends against it / warns the user off
- "sentiment": overall tone toward the entity: "positive" | "neutral" | "mixed" | "negative".
- "claims_positive": short phrases for positives the answer states (max 5).
- "claims_negative": short phrases for criticisms/drawbacks the answer raises (max 5).
- "negative_sources": domains or URLs the answer cites that carry negative signal (complaint threads, negative reviews); [] if none.
- "rationale": one short sentence justifying the labels.

If "mentioned" is false, still include the entity with neutral placeholder labels.

Tracked entities (use the canonical name as the JSON key; recognize the aliases):
${formatEntities(entities)}

Respond ONLY with valid JSON, no prose:
{
  "entities": {
    "<canonical name>": {
      "mentioned": true,
      "verdict": "clear_yes",
      "sentiment": "positive",
      "claims_positive": ["..."],
      "claims_negative": ["..."],
      "negative_sources": ["..."],
      "rationale": "..."
    }
  },
  "summary": "1-2 sentences about the answer overall"
}`;
}

function discoverySystemPrompt(entities: JudgeEntity[]): string {
  return `You are a brand-visibility analyst. You read an AI assistant's answer to a user's question and judge how that answer portrays specific brands. You do NOT answer the user's question yourself — you only assess what the answer says.

This question is NOT about one specific brand — the user asks for options or the best tool in a category. What matters is whether each tracked entity shows up and how prominently. For each tracked entity, classify:

- "presence": "featured" (highlighted / lead recommendation) | "listed" (one of several named options) | "mentioned" (only in passing) | "not_mentioned".
- "rank": position among the named options: "top" | "middle" | "bottom" | "not_listed" (use "not_listed" when presence is "not_mentioned").
- "sentiment": tone when mentioned: "positive" | "neutral" | "negative".
- "claims_positive": short phrases for positives the answer states (max 5).
- "claims_negative": short phrases for criticisms/drawbacks the answer raises (max 5).
- "negative_sources": domains or URLs the answer cites that carry negative signal; [] if none.
- "rationale": one short sentence justifying the labels.

Include every tracked entity, even if "not_mentioned".

Tracked entities (use the canonical name as the JSON key; recognize the aliases):
${formatEntities(entities)}

Respond ONLY with valid JSON, no prose:
{
  "entities": {
    "<canonical name>": {
      "presence": "listed",
      "rank": "middle",
      "sentiment": "neutral",
      "claims_positive": ["..."],
      "claims_negative": ["..."],
      "negative_sources": ["..."],
      "rationale": "..."
    }
  },
  "summary": "1-2 sentences about the answer overall"
}`;
}

function userPrompt(input: JudgeInput): string {
  const answer =
    input.answer.length > MAX_ANSWER_CHARS
      ? input.answer.slice(0, MAX_ANSWER_CHARS) + "\n... [truncated]"
      : input.answer;
  const sources = input.sources.length > 0 ? input.sources.join("\n") : "(none cited)";
  return `=== USER'S QUESTION (asked to the assistant being monitored) ===
${input.prompt}

=== ASSISTANT'S ANSWER (this is what you judge) ===
${answer}

=== SOURCES THE ANSWER CITED ===
${sources}

Judge how this answer portrays the tracked entities. Return JSON only.`;
}

// --- response parsing/normalization (defensive: coerce labels, re-key to canonical) ---

function coerce<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function strArray(value: unknown, max = 5): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((s): s is string => typeof s === "string").slice(0, max);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Find the model's entry for one tracked entity, matching key by name or alias (case-insensitive). */
function findEntry(
  responseEntities: Record<string, unknown>,
  entity: JudgeEntity,
): Record<string, unknown> | null {
  const names = [entity.name, ...entity.aliases].map((n) => n.toLowerCase());
  for (const [key, val] of Object.entries(responseEntities)) {
    if (names.includes(key.toLowerCase()) && val && typeof val === "object") {
      return val as Record<string, unknown>;
    }
  }
  return null;
}

function normalizeBrandEntity(raw: Record<string, unknown> | null): BrandEntityVerdict {
  const mentioned = raw ? raw.mentioned !== false : false;
  const v: BrandEntityVerdict = {
    mentioned,
    verdict: coerce(raw?.verdict, BRAND_VERDICT, "depends"),
    sentiment: coerce(raw?.sentiment, BRAND_SENTIMENT, "neutral"),
    score: 0,
    claims_positive: strArray(raw?.claims_positive),
    claims_negative: strArray(raw?.claims_negative),
    negative_sources: strArray(raw?.negative_sources),
    rationale: str(raw?.rationale),
  };
  v.score = scoreBrand(v);
  return v;
}

function normalizeDiscoveryEntity(raw: Record<string, unknown> | null): DiscoveryEntityVerdict {
  const presence = coerce(raw?.presence, DISCOVERY_PRESENCE, "not_mentioned");
  const v: DiscoveryEntityVerdict = {
    presence,
    rank: coerce(raw?.rank, DISCOVERY_RANK, presence === "not_mentioned" ? "not_listed" : "middle"),
    sentiment: coerce(raw?.sentiment, DISCOVERY_SENTIMENT, "neutral"),
    score: 0,
    claims_positive: strArray(raw?.claims_positive),
    claims_negative: strArray(raw?.claims_negative),
    negative_sources: strArray(raw?.negative_sources),
    rationale: str(raw?.rationale),
  };
  v.score = scoreDiscovery(v);
  return v;
}

function normalize(input: JudgeInput, parsed: Record<string, unknown>): JudgeVerdict {
  const responseEntities =
    parsed.entities && typeof parsed.entities === "object"
      ? (parsed.entities as Record<string, unknown>)
      : {};
  const summary = str(parsed.summary);

  if (input.rubric === "brand") {
    const entities: Record<string, BrandEntityVerdict> = {};
    for (const e of entityList(input)) {
      entities[e.name] = normalizeBrandEntity(findEntry(responseEntities, e));
    }
    return { rubric: "brand", entities, summary };
  }

  const entities: Record<string, DiscoveryEntityVerdict> = {};
  for (const e of entityList(input)) {
    entities[e.name] = normalizeDiscoveryEntity(findEntry(responseEntities, e));
  }
  return { rubric: "discovery", entities, summary };
}

// --- main ---

export async function judgeRun(input: JudgeInput): Promise<JudgeResult> {
  const apiKey = process.env.OPENROUTER_KEY;
  if (!apiKey) return { ok: false, error: "OPENROUTER_KEY is not set." };

  const entities = entityList(input);
  const system =
    input.rubric === "brand" ? brandSystemPrompt(entities) : discoverySystemPrompt(entities);

  try {
    const response = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: JUDGE_MODEL,
        messages: [
          { role: "system", content: system },
          { role: "user", content: userPrompt(input) },
        ],
        temperature: 0.2,
        response_format: { type: "json_object" },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      return { ok: false, error: `OpenRouter ${response.status}: ${errorText}` };
    }

    const json = await response.json();
    const content = json?.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      return { ok: false, error: "No content in OpenRouter response." };
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(content);
    } catch {
      return { ok: false, error: "Judge returned non-JSON content." };
    }

    return { ok: true, verdict: normalize(input, parsed) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
