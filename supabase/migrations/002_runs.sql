-- geo-aeo-tracker: runs as first-class rows
--
-- v1.2 stored every run inside the single kv_store JSON blob. That breaks
-- down once an external analyzer needs to write verdicts concurrently with
-- the app's autosave (last-write-wins on one blob), and it makes historical
-- SQL analysis impossible. This migration gives each run its own row and
-- adds a table for LLM analyzer verdicts.
--
-- Access model is identical to kv_store: written only by the Next.js server
-- (service_role) — RLS on, no policies, so anon/authenticated have no access.

create table if not exists public.runs (
  id            uuid primary key default gen_random_uuid(),
  workspace     text not null default 'default',
  created_at    timestamptz not null default now(),
  provider      text not null,
  prompt        text not null,
  answer        text not null,
  sources       jsonb not null default '[]',
  -- cheap heuristics computed client-side at insert time
  visibility_score    int,
  sentiment           text,
  brand_mentions      jsonb,
  competitor_mentions jsonb
);

create index if not exists runs_workspace_created_at_idx
  on public.runs (workspace, created_at desc);
create index if not exists runs_prompt_idx
  on public.runs (prompt);

alter table public.runs enable row level security;

-- LLM analyzer verdicts. One run can be analyzed by multiple analyzers
-- and rubric versions; raw runs stay immutable.
create table if not exists public.run_analyses (
  id             uuid primary key default gen_random_uuid(),
  run_id         uuid not null references public.runs(id) on delete cascade,
  analyzer       text not null,             -- 'claude-code' | 'openrouter:<model>'
  rubric_version text not null,             -- 'v1', 'v2', ...
  verdict        jsonb not null,            -- per-brand breakdown, see docs/runs-table-plan.md
  created_at     timestamptz not null default now(),
  unique (run_id, analyzer, rubric_version)
);

create index if not exists run_analyses_run_id_idx
  on public.run_analyses (run_id);

alter table public.run_analyses enable row level security;
