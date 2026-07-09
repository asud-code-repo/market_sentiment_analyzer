-- crash_probability_* and scenario_*_pct are Claude's qualitative synthesis
-- output at chat-time (see master prompt's "Comprehensive Real-Time Crash
-- Assessment" task), not something the deterministic Stage 3 rule engine can
-- compute. But Stage 3 needs to write a row daily with just the mechanical
-- indicator panel + wave status, ahead of any chat-triggered full run.
-- Relaxing these from NOT NULL lets the rule engine insert a partial row;
-- Claude's write_snapshot tool (Stage 4) fills in the rest later the same day.
alter table crash_checks
  alter column crash_probability_pct drop not null,
  alter column crash_probability_low_pct drop not null,
  alter column crash_probability_high_pct drop not null,
  alter column scenario_bull_pct drop not null,
  alter column scenario_base_pct drop not null,
  alter column scenario_bear_pct drop not null,
  alter column scenario_crash_pct drop not null;

-- The scenario-sums-to-100 check must tolerate all-NULL rows (rule-engine-only
-- inserts) while still enforcing the sum once a chat run fills all four in.
alter table crash_checks drop constraint scenario_sums_to_100;
alter table crash_checks add constraint scenario_sums_to_100 check (
  (scenario_bull_pct is null and scenario_base_pct is null
    and scenario_bear_pct is null and scenario_crash_pct is null)
  or abs((scenario_bull_pct + scenario_base_pct + scenario_bear_pct + scenario_crash_pct) - 100) < 0.5
);
