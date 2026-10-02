-- Fixes a real bug caught via live browser testing (2026-10-02): the
-- dashboard's Insider Activity card queries watchlist_tickers directly
-- with the public anon key (to know which 7 symbols to show, same as
-- mcp_server's computeInsiderClusterSignals -- see
-- dashboard_site/index.html's insider-activity data-loading block) and was
-- silently getting HTTP 401, because this table was left deny-all for
-- anon at creation time (20260711000000) -- unlike data_points/crash_checks,
-- which got this same anon-read treatment retroactively (20260709000400/500)
-- once a public consumer actually needed them. Same reasoning as those two,
-- and as this table's own original comment already states: ticker symbols
-- alone aren't personal data, safe to expose read-only.
create policy "anon read-only watchlist_tickers"
  on watchlist_tickers for select
  to anon
  using (true);

grant usage on schema public to anon;
grant select on watchlist_tickers to anon;
