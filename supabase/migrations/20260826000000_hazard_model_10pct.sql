-- Statistical hazard model (10% drawdown target) — see
-- reference_docs/rules/crash-check-rules.md's "Statistical Hazard Model"
-- section. Walk-forward validated (expanding window, leave-one-crisis-out
-- across dot-com/GFC/Dec-2018/COVID/2022), isotonic-recalibrated, block-
-- bootstrap CI confirmed vs. base rate for the 10% target specifically. A
-- companion 20%-drawdown target was tested and shelved (CI spanned zero,
-- no distinguishable edge given only 4 usable real episodes) — not
-- represented here.
--
-- Computed once daily by rule_engine/src/hazardModel.ts, alongside the
-- existing 6-indicator panel — this is rule-engine-owned/deterministic,
-- NOT LLM judgment (contrast with crash_probability_pct, which is 100%
-- LLM-synthesized — see crash-check-rules.md's "Crash-Probability Scoring
-- Methodology (DEFERRED)" section for that history).
--
-- calibrated_pct is the number to report; raw_pct is retained only as
-- supporting/debug detail — the model's own isotonic calibration curve is
-- steppy/plateaued, so a raw score isn't a meaningfully different
-- probability read across most of its own range, hence the banding.
--
-- All nullable, no default: classify.ts wraps hazard computation in a
-- try/catch and nulls these out on failure (e.g. a transient gap in one
-- input series) rather than failing the whole classify() run — unlike the
-- 6 core indicators, this is an additive, non-gating cross-check where
-- "temporarily unavailable" is a safe, honest state to persist.
alter table crash_checks add column hazard_10pct_raw_pct numeric(5,2);
alter table crash_checks add column hazard_10pct_calibrated_pct numeric(5,2);
alter table crash_checks add column hazard_10pct_band text
  check (hazard_10pct_band in ('LOW', 'TRANSITIONING', 'HIGH'));
alter table crash_checks add column hazard_10pct_as_of date;
