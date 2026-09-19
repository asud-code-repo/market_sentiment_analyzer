-- Slow-bear wave pathway — see rule_engine/src/rules.ts's
-- slowBearW2Condition/slowBearW3Condition. A second, independent way to
-- reach Wave 2/3 alongside the original drawdown+VIX pathway, for crises
-- where price damage is severe but volatility never sustains at panic
-- levels. Backtest-validated against 33 years / 8,467 trading days of real
-- SPY+VIX+FRED history (external Phase 0 Wave Backtest, then a follow-up
-- design pass 2026-09-19): the original pathway alone never confirmed
-- Wave 3 for dot-com (the single worst crash in the dataset, -49.1%) or
-- Wave 2 for 2022's grinding, low-volatility bear.
--
-- sp500_days_since_252d_low backs this pathway's freshness filter — a
-- fresh ~1-year rolling S&P low, distinguishing actively deteriorating
-- markets from ones merely still below a stale multi-year-old peak (SPY
-- didn't reclaim its Oct-2007 high until 2013). Carried forward day-to-day
-- like sp500_trough, not recomputed from full history each run.
--
-- wave_active_reason records which pathway actually produced wave_active
-- (FAST_PANIC or SLOW_BEAR) — null whenever wave_active is NONE.
alter table crash_checks add column sp500_days_since_252d_low integer;
alter table crash_checks add column wave_active_reason text
  check (wave_active_reason in ('FAST_PANIC', 'SLOW_BEAR'));
