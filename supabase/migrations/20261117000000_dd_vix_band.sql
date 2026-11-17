-- Drawdown + VIX risk band on crash_checks (reference_docs/
-- hazard-model-rebuild-brief.md, outcome 2026-11-17). The logistic hazard
-- model and three rebuilt variants all failed to beat this two-input rule
-- out of sample, so the dashboard and MCP now show the rule instead:
--   score = S&P drawdown % + VIX / 5
--   LOW < 8.5, TRANSITIONING 8.5 to < 10, HIGH >= 10
-- (rule_engine/src/hazardScorecard.ts; same cutoffs the hazard_scorecard
-- table has recorded since 2026-11-16; never retuned after live outcomes).
--
-- Both columns are null when live drawdown is already >= 10% (the question
-- "could a 10% drawdown start?" no longer applies) and on rows written
-- before this migration. The hazard_10pct_* columns stay: the model is
-- still computed for the scorecard, just no longer shown.
--
-- APPLY THIS BEFORE DEPLOYING THE CODE THAT WRITES OR SELECTS THESE COLUMNS:
-- the rule engine insert, write_snapshot and the dashboard query all name them.
alter table crash_checks add column if not exists dd_vix_score numeric(6,2);
alter table crash_checks add column if not exists dd_vix_band text
  check (dd_vix_band in ('LOW', 'TRANSITIONING', 'HIGH'));
