-- Hazard model eligibility status — see reference_docs/rules/crash-check-rules.md's
-- "Statistical Hazard Model" section. The model's target is P(S&P drawdown
-- reaches >=10% from ATH within ~21 trading days | not already past that
-- threshold) — a FUTURE-BREACH forecast, conditional on not already being
-- in a >=10% drawdown. Previously classify.ts scored every run regardless
-- of current drawdown, so during an existing correction the model still
-- produced a HIGH/TRANSITIONING/LOW band for a question that doesn't apply
-- (external review 2026-09-19, F01) — a 16% drawdown was found to still
-- invoke the scorer and persist HIGH, which cannot mean "further-loss
-- probability" since reaching 10% from the same peak may already require
-- far less than a fresh 10% decline from today's price.
--
-- hazard_10pct_band/raw_pct/calibrated_pct stay null in both non-eligible
-- cases (already_breached and unavailable) — this column is what
-- distinguishes "the question doesn't apply right now" from "the
-- computation failed this run", so a null band is never misread as either
-- "no risk" or "temporarily unavailable" when it's actually the former.
alter table crash_checks add column hazard_10pct_status text
  check (hazard_10pct_status in ('ELIGIBLE', 'ALREADY_BREACHED', 'UNAVAILABLE'));
