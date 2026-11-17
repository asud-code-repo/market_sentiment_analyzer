-- Hazard model live scorecard (reference_docs/hazard-model-rebuild-brief.md,
-- Stage 0). One row per as-of date the hazard model scored: the model's
-- band, a simple drawdown + VIX baseline band (rule_engine/src/
-- hazardScorecard.ts, cutoffs fixed 2026-11-16 before any live outcome),
-- and, once 21 / 63 more S&P closes exist, whether the S&P touched a >=10%
-- drawdown from its running all-time high in that window.
--
-- Written only by rule_engine (service role) at the end of each classify()
-- run; report-only, read by nothing that makes a decision. Public market
-- inputs and model outputs only, so anon read access is safe, same as
-- crash_checks. Never add personal or policy fields to this table.

create table if not exists hazard_scorecard (
  as_of_date date primary key,
  model_version text not null,
  model_band text check (model_band in ('LOW', 'TRANSITIONING', 'HIGH')),
  model_raw_pct numeric(5,2),
  baseline_version text not null,
  baseline_score numeric(6,2) not null,
  baseline_band text not null check (baseline_band in ('LOW', 'TRANSITIONING', 'HIGH')),
  sp500_level numeric not null,
  sp500_ath numeric not null,
  drawdown_pct numeric(6,2) not null,
  vix numeric(6,2) not null,
  -- Model input snapshot (the 32 feature values) for days scored live;
  -- null for days backfilled from crash_checks, which didn't store them.
  inputs jsonb,
  outcome_21d boolean,
  max_drawdown_21d_pct numeric(6,2),
  resolved_21d_on date,
  outcome_63d boolean,
  max_drawdown_63d_pct numeric(6,2),
  resolved_63d_on date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table hazard_scorecard enable row level security;

create policy "anon read-only hazard_scorecard"
  on hazard_scorecard for select
  to anon
  using (true);

grant select on hazard_scorecard to anon;
grant select, insert, update, delete on hazard_scorecard to service_role;
