-- geo-aeo-tracker: prompt tags on runs
--
-- The brand-eval analyzer (run_analyses) picks a scoring rubric from the
-- prompt's tag ('brand' vs 'discovery'). Storing the prompt's tags on the run
-- keeps analysis self-contained: re-tagging a prompt later does not rewrite the
-- rubric used for historical runs, and a future cron re-analyze knows the rubric
-- without depending on the current prompt config in kv_store.
--
-- See docs/brand-eval-plan.md.

alter table public.runs
  add column if not exists prompt_tags text[] not null default '{}';
