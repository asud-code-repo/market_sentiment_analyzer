-- Merges Portfolio Opportunity Review content into the Full Report page
-- (backlog_unify_crash_check_dashboard_site) — this reverses the earlier
-- "portfolio-review-template.html is permanently chat-only, never
-- published" decision, per explicit user instruction 2026-07-16.
--
-- Same access pattern as full_report_snapshots: NOT anon-readable. RLS
-- enabled with zero policies for anon/authenticated (deny-all); only
-- service_role gets the GRANT below. The only reader is the Full Report
-- Cloudflare Pages Function, which holds the service_role key server-side,
-- behind Cloudflare Access, never shipped to the browser.
create table portfolio_review_snapshots (
  id                      uuid primary key default gen_random_uuid(),
  run_at                  timestamptz not null default now(),

  -- Qualitative synthesis from this review run.
  verdict                 text,
  summary                 text,
  macro_cross_reference   text,

  -- Recomputed server-side from computePortfolioDrift() at write time, not
  -- trusted from the caller -- same "rule engine output contract"
  -- discipline as write_full_report's watchlist recomputation. Shape:
  -- { accounts: [{account_key, label, entries: [{fund, actual_pct,
  --   target_pct, drift_pts, status}], max_drift_pts, has_drifted}],
  --   standing_flags: [string] }
  drift                   jsonb,

  -- Per-ticker qualitative thesis overlay only -- NOT price/status (that
  -- still comes from full_report_snapshots.watchlist, cross-referenced by
  -- symbol at render time) and NOT max_position_usd, which stays
  -- local-only same as everywhere else. Shape: [{ symbol, thesis_verdict,
  -- proposed_change, reasoning }]
  tickers                 jsonb not null default '[]',

  -- Risk Radar: 0-100 judgment scores per axis (geopolitical, policy_fed,
  -- inflation, valuation, labor_market, earnings), Claude's own synthesis
  -- each run -- judgment output, not a rule-engine binding, same treatment
  -- as crash_type_diagnosis. The Pages Function diffs this row's values
  -- against the previous row's to draw the "current vs prior" chart, so
  -- no separate prior-value storage is needed here.
  risk_radar              jsonb,

  -- Points back at the crash_checks row current when this review ran, for
  -- audit -- mirrors full_report_snapshots.source_crash_check_id.
  source_crash_check_id   uuid references crash_checks(id),

  created_at              timestamptz not null default now()
);

create index portfolio_review_snapshots_run_at_idx on portfolio_review_snapshots (run_at desc);

alter table portfolio_review_snapshots enable row level security;
-- No policies defined: deny-all for anon/authenticated.

grant usage on schema public to service_role;
grant select, insert, update, delete on portfolio_review_snapshots to service_role;
