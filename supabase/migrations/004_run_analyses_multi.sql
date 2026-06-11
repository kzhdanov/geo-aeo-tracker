-- geo-aeo-tracker: allow multiple analyses per run
--
-- 002 created run_analyses with unique(run_id, analyzer, rubric_version) so a
-- run could be scored at most once per (analyzer, rubric). The brand-eval flow
-- now wants the opposite for manual re-judging: clicking "Launch the judge"
-- again should APPEND a fresh verdict, not overwrite — every judgment is its own
-- timestamped row, like the runs themselves.
--
-- So we drop that unique constraint. Idempotency for the automatic/cron path no
-- longer lives in the DB: the analyze-runs route only judges runs that have no
-- analysis yet for the current analyzer+rubric_version (a query-level guard).
-- Manual calls pass explicit runIds and always insert.
--
-- Drop by lookup rather than by name: the constraint's auto-generated name is
-- environment-dependent, and run_analyses has exactly one unique constraint.
-- See docs/brand-eval-plan.md.

do $$
declare
  con text;
begin
  for con in
    select conname
    from pg_constraint
    where conrelid = 'public.run_analyses'::regclass
      and contype = 'u'
  loop
    execute format('alter table public.run_analyses drop constraint %I', con);
  end loop;
end $$;
