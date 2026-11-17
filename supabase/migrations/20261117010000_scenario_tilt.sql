-- LLM scenario tilt (2026-11-17). The bull/base/bear/crash split is no
-- longer free LLM judgment: write_snapshot starts from a frozen historical
-- prior for the run's drawdown risk band (config/scenario_prior_v1.json,
-- built in the private research repo) and the LLM picks one tilt (lower /
-- in_line / higher), which moves a fixed 5 points. Buckets are defined over
-- the next 63 trading days from the as-of S&P close (see the rules doc,
-- "Crash-Probability Scoring Methodology"). crash_probability_pct on these
-- rows is bear + crash: the chance of a 10%+ fall within 3 months.
--
-- Rows before this migration keep their old, undefined split
-- (scenario_method null).
--
-- APPLY THIS BEFORE DEPLOYING THE CODE THAT WRITES THESE COLUMNS: the rule
-- engine insert (sp500_as_of) and write_snapshot both name them.

alter table crash_checks add column if not exists sp500_as_of date;
alter table crash_checks add column if not exists scenario_method text
  check (scenario_method in ('tilt_v1'));
alter table crash_checks add column if not exists scenario_prior_state text
  check (scenario_prior_state in ('LOW', 'TRANSITIONING', 'HIGH', 'ALREADY_BREACHED'));
alter table crash_checks add column if not exists scenario_tilt text
  check (scenario_tilt in ('lower', 'in_line', 'higher'));
alter table crash_checks add column if not exists scenario_tilt_reasons jsonb;

-- One row per tilt-based full report, written and resolved by rule_engine
-- (service role). Report-only: nothing reads it to make a decision. Public
-- market inputs and the public split only, so anon read is safe, same as
-- crash_checks. Never add personal or policy fields.
create table if not exists scenario_scorecard (
  crash_check_id uuid primary key references crash_checks(id) on delete cascade,
  run_at timestamptz not null,
  as_of_date date not null,
  sp500_close numeric not null,
  prior_version text not null,
  prior_state text not null check (prior_state in ('LOW', 'TRANSITIONING', 'HIGH', 'ALREADY_BREACHED')),
  tilt text not null check (tilt in ('lower', 'in_line', 'higher')),
  prior_bull smallint not null, prior_base smallint not null, prior_bear smallint not null, prior_crash smallint not null,
  bull smallint not null, base smallint not null, bear smallint not null, crash smallint not null,
  -- Filled once 63 more S&P closes exist after as_of_date.
  outcome_bucket text check (outcome_bucket in ('bull', 'base', 'bear', 'crash')),
  worst_fall_63d_pct numeric(6,2),
  return_63d_pct numeric(6,2),
  resolved_on date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table scenario_scorecard enable row level security;

create policy "anon read-only scenario_scorecard"
  on scenario_scorecard for select
  to anon
  using (true);

grant select on scenario_scorecard to anon;
grant select, insert, update, delete on scenario_scorecard to service_role;
