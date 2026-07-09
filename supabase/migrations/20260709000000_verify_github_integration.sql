-- Trivial, safe verification migration: confirms the Supabase <-> GitHub
-- deploy integration picks up pushes to main. Adds documentation only,
-- no schema change.
comment on table crash_checks is
  'One row per macro crash-check run. Rules this table''s columns encode live in reference_docs/rules/crash-check-rules.md.';

comment on table data_points is
  'Raw ingested numeric series (FRED/EIA/CBOE/Polymarket), separate from crash_checks interpretation.';
