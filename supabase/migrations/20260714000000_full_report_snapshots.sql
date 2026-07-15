-- Full Report page (backlog_unify_crash_check_dashboard_site): a new,
-- separate Cloudflare Pages project shows the BrokerageLink watchlist
-- (tickers + wave targets), the crash-type diagnosis narrative, and the
-- qualitative-only parts of the personal portfolio snapshot — content
-- that's too specific to be on the existing public dashboard_site, but
-- still contains zero personal dollar figures (enforced in code by
-- write_full_report calling the same findLeakedDollarFigures() guardrail
-- write_snapshot uses — see mcp_server/src/lib/portfolio.ts).
--
-- Unlike crash_checks/data_points, this table is NOT anon-readable. RLS is
-- enabled with zero policies for anon/authenticated (deny-all), and even
-- service_role only gets the GRANT below, not a policy — the only reader is
-- the Cloudflare Pages Function (full_report_site/), which holds the
-- service_role key server-side, behind Cloudflare Access, and is never
-- shipped to the browser. This is why a separate table was required instead
-- of new columns on crash_checks: RLS is row-level, so mixing public and
-- gated columns in one table would expose the gated columns to the existing
-- anon key too.
create table full_report_snapshots (
  id                      uuid primary key default gen_random_uuid(),
  run_at                  timestamptz not null default now(),

  -- Watchlist status at time of writing — one row per ticker. Deliberately
  -- excludes max_position_usd (personal position sizing), which stays
  -- local-only in local_state/brokeragelink_watchlist.yaml, same as today.
  -- Shape: [{ symbol, name, theme, wave1_target, wave2_target, wave3_target,
  --   wave3_only, thesis_note, current_price, price_as_of, pct_above_wave1,
  --   status }, ...]
  watchlist               jsonb not null default '[]',

  -- Crash-type diagnosis, structured for rendering rather than free text.
  -- Shape: { type, criteria: [{ name, status, detail }] }
  crash_type_diagnosis    jsonb,

  -- Qualitative-only portfolio context (dry-powder status, NYL Anchor real
  -- yield read, SIP thesis check, RRSP/spouse-401k status, crash readiness
  -- narrative). Must NOT contain personal dollar amounts — the
  -- opportunity-cost gap line stays chat-only, permanently, never written
  -- here. Enforced by write_full_report's guardrail check, not just this
  -- comment.
  portfolio_context       text,

  -- Points back at the crash_checks row this snapshot was derived from, for
  -- audit — mirrors write_snapshot's raw_source_data.copied_from_crash_check_id.
  source_crash_check_id   uuid references crash_checks(id),

  created_at              timestamptz not null default now()
);

create index full_report_snapshots_run_at_idx on full_report_snapshots (run_at desc);

alter table full_report_snapshots enable row level security;
-- No policies defined: deny-all for anon/authenticated, matching the
-- deliberate "no client-side credential can ever read this" design — the
-- Pages Function is the only intended reader, via service_role.

grant usage on schema public to service_role;
grant select, insert, update, delete on full_report_snapshots to service_role;
