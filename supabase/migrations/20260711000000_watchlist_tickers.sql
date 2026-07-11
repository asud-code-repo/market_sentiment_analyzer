-- Track C: the BrokerageLink watchlist ticker *list* (symbols only — no
-- price targets, thesis notes, or position sizing, all of which stay in the
-- gitignored local_state/brokeragelink_watchlist.yaml) needs to be readable
-- by the ingestion Action running in CI, which has no access to that local
-- file. Previously this was a manually-maintained WATCHLIST_TICKERS repo
-- variable; storing it here instead lets write_watchlist (mcp_server) keep
-- both the local file and this table in sync in one call, removing the
-- manual step. Ticker symbols alone aren't personal data — safe here by the
-- same reasoning as SP500 or any other public market series.
create table watchlist_tickers (
  symbol      text primary key,
  added_at    timestamptz not null default now()
);

alter table watchlist_tickers enable row level security;
-- No policies defined: deny-all for anon/authenticated, same as data_points.
-- service_role bypasses RLS but still needs the base GRANT below (see the
-- service_role GRANT lesson from 20260709000100 — RLS bypass and table
-- privileges are separate mechanisms).
grant usage on schema public to service_role;
grant select, insert, update, delete on watchlist_tickers to service_role;
