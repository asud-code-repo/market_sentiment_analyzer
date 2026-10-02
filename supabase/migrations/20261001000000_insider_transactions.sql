-- Insider Form 4 cluster-buy signal (backlog: 13F/insider positioning
-- discussion). Stores individual open-market insider transactions (SEC Form
-- 4, transaction codes P/S only -- filtered at ingest in
-- ingestion/src/sources/secForm4.ts) for the BrokerageLink watchlist
-- tickers. This is public SEC filing data about public companies, not
-- personal data -- safe to grant anon SELECT by the same reasoning as
-- crash_checks/data_points (see 20260709000400's "never extend this
-- pattern to any table that could hold personal data" rule: this table
-- doesn't). Anon read is needed because dashboard_site computes the
-- cluster-buy flag client-side from these raw rows, same duplicated-
-- formula convention as sector_rotation/fiscal-dominance (mcp_server's
-- insiderCluster.ts and dashboard_site's render function both read the raw
-- rows and compute independently -- never a persisted derived flag).
create table insider_transactions (
  id                      bigint generated always as identity primary key,
  ticker                  text not null,
  issuer_cik              text not null,
  accession_number        text not null,
  line_no                 int not null,        -- index within the filing's nonDerivativeTable, makes multi-row filings addressable
  owner_name              text not null,
  owner_cik               text not null,
  is_officer              boolean not null default false,
  is_director             boolean not null default false,
  is_ten_percent_owner    boolean not null default false,
  officer_title           text,
  transaction_code        text not null,       -- 'P' or 'S' only, filtered at ingest -- see secForm4.ts
  transaction_date        date not null,
  shares                  numeric not null,
  price_per_share         numeric,
  acquired_disposed_code  text,
  is_10b5_1               boolean not null default false,
  filed_at                date not null,
  ingested_at             timestamptz not null default now(),

  unique (accession_number, line_no)
);

create index insider_transactions_ticker_date_idx on insider_transactions (ticker, transaction_date desc);

alter table insider_transactions enable row level security;

create policy "anon read-only insider_transactions"
  on insider_transactions for select
  to anon
  using (true);

grant usage on schema public to service_role;
grant select, insert, update, delete on insider_transactions to service_role;

grant usage on schema public to anon;
grant select on insider_transactions to anon;
