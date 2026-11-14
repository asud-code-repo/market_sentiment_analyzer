-- Keeping personal policy off the public tables, part 1 of 2 (additive
-- only). Safe to apply before the code that uses it is deployed: nothing
-- existing changes.
--
-- 1. private_data_points: watchlist ticker prices. Same shape as
--    data_points, but service-role only, so the anon key the public
--    dashboard ships can't list the watchlist. Public context tickers
--    (SPY, IWM, RSP, KRE, GLD, SLV, X:BTCUSD) stay in data_points.
-- 2. full_report_snapshots gains the private-only fields write_full_report
--    now records: wave status (evaluated locally from the private policy),
--    personal triggers, and watchlist insider activity.

create table if not exists private_data_points (like data_points including all);

alter table private_data_points enable row level security;
-- No policies: deny-all for anon/authenticated, same as the snapshot tables.
revoke all on private_data_points from anon, authenticated;
grant usage on schema public to service_role;
grant select, insert, update, delete on private_data_points to service_role;

alter table full_report_snapshots
  add column if not exists wave_status jsonb,
  add column if not exists personal_triggers jsonb,
  add column if not exists insider_activity jsonb;
