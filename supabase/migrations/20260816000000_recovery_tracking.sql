-- Stage 4 recovery tracking (crash-check-rules.md "Recovery Signal and
-- 6-Month Transition") moves from pure prose to real deterministic
-- detection in the rule engine (classify.ts). sp500_trough/_date track a
-- running minimum while a drawdown episode (>=10% from ATH) is active, null
-- otherwise. recovery_confirmed is a historical fact about the most recent
-- episode — set true once all three Stage 4 criteria are simultaneously
-- true, reset to false only when a new drawdown episode begins.
alter table crash_checks add column sp500_trough numeric(9,2);
alter table crash_checks add column sp500_trough_date date;
alter table crash_checks add column recovery_confirmed boolean not null default false;
alter table crash_checks add column recovery_confirmed_date date;
