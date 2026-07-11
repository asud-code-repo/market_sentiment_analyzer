-- One-time seed matching local_state/brokeragelink_watchlist.yaml's current
-- 7 tickers (seeded from master-prompt-original.md's original table). Future
-- additions/removals go through write_watchlist, not a migration.
insert into watchlist_tickers (symbol) values
  ('EOG'), ('LNG'), ('CCJ'), ('LLY'), ('NTR'), ('BIP'), ('NVDA')
on conflict (symbol) do nothing;
