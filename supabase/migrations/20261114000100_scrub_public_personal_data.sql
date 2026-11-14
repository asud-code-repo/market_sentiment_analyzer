-- Keeping personal policy off the public tables, part 2 of 2 (destructive).
-- Apply only AFTER the code from the same change is deployed and verified:
-- the rule engine no longer writes wave columns, and no reader selects them.
--
-- Everything removed or rewritten is first copied into service-role-only
-- backup tables, so this can be undone. Runs as one transaction.

begin;

-- 1. Private backups.
create table private_scrub_backup_20261114 as
  select id, run_at, wave_active, wave_active_reason,
         confirmation_state -> 'slow_bear_w2' as slow_bear_w2,
         confirmation_state -> 'slow_bear_w3' as slow_bear_w3,
         trigger_status, notes, delta_log, risk_radar, risk_radar_anchors
  from crash_checks;

create table private_scrub_backup_20261114_review_radar as
  select id, run_at, risk_radar from portfolio_review_snapshots where risk_radar is not null;

alter table private_scrub_backup_20261114 enable row level security;
alter table private_scrub_backup_20261114_review_radar enable row level security;
revoke all on private_scrub_backup_20261114 from anon, authenticated;
revoke all on private_scrub_backup_20261114_review_radar from anon, authenticated;
grant select on private_scrub_backup_20261114 to service_role;
grant select on private_scrub_backup_20261114_review_radar to service_role;

-- 2. Watchlist ticker prices move to private_data_points.
insert into private_data_points (series_id, source, source_series_code, observation_date, value, unit, raw_payload, ingested_at)
  select series_id, source, source_series_code, observation_date, value, unit, raw_payload, ingested_at
  from data_points
  where source = 'MASSIVE' and series_id not in ('IWM', 'SPY', 'RSP', 'KRE', 'GLD', 'SLV', 'X:BTCUSD')
on conflict (series_id, observation_date) do nothing;

delete from data_points
  where source = 'MASSIVE' and series_id not in ('IWM', 'SPY', 'RSP', 'KRE', 'GLD', 'SLV', 'X:BTCUSD');

-- 3. Public rows keep only market-event triggers (personal ones, e.g. the
--    stable-value rate reset, now live on full_report_snapshots) and lose
--    the slow-bear wave state (now evaluated locally).
update crash_checks
  set trigger_status = coalesce(
    (select jsonb_agg(e) from jsonb_array_elements(trigger_status) e
      where lower(e ->> 'name') ~ '^(fed-event|inflation-print|fiscal-event|earnings-guidance) trigger'),
    '[]'::jsonb)
  where jsonb_typeof(trigger_status) = 'array';

update crash_checks
  set confirmation_state = confirmation_state - 'slow_bear_w2' - 'slow_bear_w3'
  where confirmation_state ? 'slow_bear_w2' or confirmation_state ? 'slow_bear_w3';

-- 4. Drop the wave columns (which wave is active is personal policy) and
--    the retired Risk Radar columns. latest_snapshot was an unused
--    `select *` view that would block the column drops.
drop view if exists latest_snapshot;

alter table crash_checks
  drop column if exists wave_active,
  drop column if exists wave_active_reason,
  drop column if exists risk_radar,
  drop column if exists risk_radar_anchors;

alter table portfolio_review_snapshots drop column if exists risk_radar;

-- 5. The watchlist and its insider activity are no longer public. Readers
--    (ingestion, mcp_server) use the service role.
drop policy if exists "anon read-only watchlist_tickers" on watchlist_tickers;
revoke select on watchlist_tickers from anon;
drop policy if exists "anon read-only insider_transactions" on insider_transactions;
revoke select on insider_transactions from anon;

commit;
