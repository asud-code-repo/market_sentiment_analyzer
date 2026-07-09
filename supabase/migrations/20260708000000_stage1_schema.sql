-- Stage 1 schema: crash_checks, latest_snapshot, data_points
-- See reference_docs/crash-check-system-build-spec.md for architecture context.
--
-- Contains NO personal account balances or dollar figures by design.
-- Personal portfolio data lives locally in local_state/portfolio.yaml (gitignored),
-- never in this database. See reference_docs/rules/crash-check-rules.md for the
-- rationale (split-storage architecture).

create extension if not exists pgcrypto;

-- ============================================================
-- crash_checks — one row per crash-check run
-- ============================================================
create table crash_checks (
  id                      uuid primary key default gen_random_uuid(),
  run_at                  timestamptz not null default now(),

  -- Crash probability
  crash_probability_pct       numeric(5,2) not null,
  crash_probability_low_pct   numeric(5,2) not null,
  crash_probability_high_pct  numeric(5,2) not null,

  -- Scenario distribution (bull/base/bear/crash — should sum to ~100)
  scenario_bull_pct      numeric(5,2) not null,
  scenario_base_pct      numeric(5,2) not null,
  scenario_bear_pct      numeric(5,2) not null,
  scenario_crash_pct     numeric(5,2) not null,
  constraint scenario_sums_to_100 check (
    abs((scenario_bull_pct + scenario_base_pct + scenario_bear_pct + scenario_crash_pct) - 100) < 0.5
  ),

  -- S&P reference data (needed to derive drawdown % and evaluate wave triggers)
  sp500_level             numeric(9,2) not null,
  sp500_ath               numeric(9,2) not null,
  sp500_ath_date          date not null,

  -- 6-indicator panel: value + GREEN/AMBER/RED color per indicator
  vix_value                numeric(6,2),
  vix_color                text check (vix_color in ('GREEN','AMBER','RED')),
  hy_spread_bps            numeric(7,1),
  hy_spread_color          text check (hy_spread_color in ('GREEN','AMBER','RED')),
  sp_drawdown_pct          numeric(5,2),
  sp_drawdown_color        text check (sp_drawdown_color in ('GREEN','AMBER','RED')),
  treasury_10y_pct         numeric(5,2),
  treasury_10y_color       text check (treasury_10y_color in ('GREEN','AMBER','RED')),
  sahm_rule_value          numeric(4,2),
  sahm_rule_color          text check (sahm_rule_color in ('GREEN','AMBER','RED')),
  fed_pivot_signal         text check (fed_pivot_signal in ('NONE','PAUSE','CUT')),
  fed_pivot_color          text check (fed_pivot_color in ('GREEN','AMBER','RED')),

  -- Rule engine outputs (deterministic, not LLM-derived — see Stage 3)
  red_count                smallint not null check (red_count between 0 and 6),
  wave_authorized          boolean not null default false,
  wave_active              text check (wave_active in ('NONE','WAVE_1','WAVE_2','WAVE_3')),
  crash_type               text check (crash_type in
                              ('A_STAGFLATION','B_RECESSION','C_CREDIT','D_AI_BUBBLE','E_HYBRID')),

  -- Warsh classification
  warsh_classification         text check (warsh_classification in
                                  ('HAWKISH','MODERATE','DOVISH','PENDING')),
  warsh_classification_date    date,
  warsh_hard_rules_active      boolean not null default false,

  -- Personal decision triggers — jsonb because the trigger set/wording changes
  -- with each master-prompt revision (v3.2 -> v3.3 already added a new trigger).
  -- Shape: [{ "name": str, "date": "YYYY-MM-DD", "status": "fired"|"approaching"|"pending", "note": str|null }, ...]
  trigger_status           jsonb not null default '[]',

  -- Narrative: macro/market synthesis only (geopolitical read, earnings commentary,
  -- crash-type diagnosis narrative). Must NOT contain personal dollar amounts or
  -- account-specific deployment instructions — those are computed client-side from
  -- local_state/portfolio.yaml and never persisted here.
  notes                    text,

  -- Snapshot of raw ingested source data used to produce this run, for audit.
  raw_source_data          jsonb not null default '{}',

  created_at               timestamptz not null default now()
);

create index crash_checks_run_at_idx on crash_checks (run_at desc);

alter table crash_checks enable row level security;
-- No policies defined: RLS enabled with zero policies = deny-all for the
-- anon/authenticated roles. The service_role key (used by the GitHub Action
-- and the local MCP server) bypasses RLS entirely by Supabase design, so it
-- needs no policy to read/write here. Add anon-role policies only if you
-- later build Stage 5's read-only dashboard and want it to query directly
-- without a service key.

-- ============================================================
-- latest_snapshot — convenience view over crash_checks
-- ============================================================
create view latest_snapshot as
select *
from crash_checks
order by run_at desc
limit 1;

-- ============================================================
-- data_points — raw ingested numeric series (FRED, CBOE, EIA, Polymarket, ...)
-- ============================================================
create table data_points (
  id                    bigint generated always as identity primary key,
  series_id             text not null,
  source                text not null,
  source_series_code    text,
  observation_date      date not null,
  value                 numeric not null,
  unit                  text,
  raw_payload           jsonb,
  ingested_at           timestamptz not null default now(),

  unique (series_id, observation_date)
);

create index data_points_series_date_idx on data_points (series_id, observation_date desc);

alter table data_points enable row level security;
-- No policies defined: deny-all for anon/authenticated. The service_role key
-- bypasses RLS by design — Stage 2's ingestion Action needs no policy added.
