-- Event-conditional scenario splits + scoring (build spec E8, 2026-11-13).
-- Written ONLY by mcp_server's write_snapshot (project-instructions step 11)
-- and returned ONLY by get_latest_snapshot (step 8), read from the last
-- full-report row. No step 1-6 tool reads these columns (anti-anchoring
-- order). The rule engine never writes them; automated refresh rows stay
-- null. Logic: mcp_server/src/lib/conditionalScenarios.ts.
--
-- conditional_scenarios: open predictions as of this full report
--   [{ event, event_date, made_on, unconditional_at_prediction: {bull,base,bear,crash},
--      branches: [{ outcome, probability, bull, base, bear, crash }],
--      last_unresolved?: { on, reason } }]
-- conditional_scoring: predictions scored in this run
--   [{ event, event_date, prediction_made_on, outcome, outcome_probability,
--      predicted_split, actual_split, change, unconditional_at_prediction,
--      reason?, scored_on }]
--
-- Macro scenario judgments only (no personal figures), so the existing
-- anon read access is acceptable; the public dashboard does not render them.
alter table crash_checks add column conditional_scenarios jsonb;
alter table crash_checks add column conditional_scoring jsonb;
