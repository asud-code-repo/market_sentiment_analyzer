import type { DataPoint } from "../lib/supabase.js";

// CFTC Commitments of Traders -- Traders in Financial Futures (TFF),
// futures-only. Added 2026-10-29: the "are big players betting for or
// against the market" signal. Free, no API key, served from the CFTC's own
// Socrata endpoint (verified live 2026-10-29, data through 2026-10-20).
// Weekly: positions as of Tuesday, published the following Friday -- the
// daily ingest run just re-upserts the trailing few weeks, so a Friday
// release lands on the next weekday run.
//
// Keyed by cftc_contract_market_code, NOT market_and_exchange_names -- the
// names were renamed in Feb 2022 (e.g. "E-MINI S&P 500 STOCK INDEX" ->
// "E-MINI S&P 500", "10-YEAR U.S. TREASURY NOTES" -> "UST 10Y NOTE") while
// the codes stayed constant back to 2006.
//
// Stored as NET position (long - short) as a % of total open interest, not
// raw contracts: open interest itself grows/shrinks over the years and
// around quarterly rolls, so raw contract counts aren't comparable across
// time. Spread positions are excluded (offsetting by definition).
const TFF_URL = "https://publicreporting.cftc.gov/resource/gpe5-46if.json";

const CONTRACTS = [
  { code: "13874A", key: "ES" }, // E-mini S&P 500
  { code: "1170E1", key: "VIX" }, // VIX futures
  { code: "043602", key: "TY" }, // 10-year Treasury note
] as const;

// Which trader groups to store per contract. Asset managers = pensions,
// mutual funds, insurers (real-money, mostly long-only). Leveraged funds =
// hedge funds/CTAs. Dealers are the other side of client flow, not a
// directional view, so they're not stored. 10y Treasury is leveraged funds
// only: their record net short there is mostly the cash-futures basis trade
// (the 2020 "dash for cash" unwind risk), and asset managers' long is just
// its other side, adding no separate information.
const GROUPS: Record<(typeof CONTRACTS)[number]["key"], ("asset_mgr" | "lev_money")[]> = {
  ES: ["asset_mgr", "lev_money"],
  VIX: ["lev_money"],
  TY: ["lev_money"],
};

const GROUP_SERIES_LABEL = { asset_mgr: "ASSET_MGR", lev_money: "LEV_FUNDS" } as const;

interface TffRow {
  report_date_as_yyyy_mm_dd: string;
  cftc_contract_market_code: string;
  open_interest_all: string;
  asset_mgr_positions_long: string;
  asset_mgr_positions_short: string;
  lev_money_positions_long: string;
  lev_money_positions_short: string;
}

async function fetchTffSince(sinceDate: string): Promise<TffRow[]> {
  const codes = CONTRACTS.map((c) => `'${c.code}'`).join(",");
  const params = new URLSearchParams({
    $select:
      "report_date_as_yyyy_mm_dd,cftc_contract_market_code,open_interest_all,asset_mgr_positions_long,asset_mgr_positions_short,lev_money_positions_long,lev_money_positions_short",
    $where: `cftc_contract_market_code in(${codes}) AND report_date_as_yyyy_mm_dd >= '${sinceDate}'`,
    $order: "report_date_as_yyyy_mm_dd",
    $limit: "50000",
  });
  const res = await fetch(`${TFF_URL}?${params}`);
  if (!res.ok) {
    throw new Error(`CFTC TFF request failed: HTTP ${res.status}`);
  }
  return (await res.json()) as TffRow[];
}

function toDataPoints(rows: TffRow[]): DataPoint[] {
  const points: DataPoint[] = [];
  for (const row of rows) {
    const contract = CONTRACTS.find((c) => c.code === row.cftc_contract_market_code);
    if (!contract) continue;
    const openInterest = Number(row.open_interest_all);
    if (!Number.isFinite(openInterest) || openInterest <= 0) continue;
    const date = row.report_date_as_yyyy_mm_dd.slice(0, 10);

    for (const group of GROUPS[contract.key]) {
      const long = Number(row[`${group}_positions_long`]);
      const short = Number(row[`${group}_positions_short`]);
      if (!Number.isFinite(long) || !Number.isFinite(short)) continue;
      points.push({
        series_id: `COT_${contract.key}_${GROUP_SERIES_LABEL[group]}_NET_PCT_OI`,
        source: "CFTC",
        source_series_code: `${contract.code}:${group}`,
        observation_date: date,
        value: Math.round(((long - short) / openInterest) * 100 * 100) / 100,
        unit: "pct_open_interest",
        raw_payload: { long, short, open_interest: openInterest },
      });
    }
  }
  return points;
}

function daysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/** Daily run: trailing ~8 weeks, re-upserted (cheap, self-heals a missed week). */
export async function fetchCftc(): Promise<DataPoint[]> {
  const points = toDataPoints(await fetchTffSince(daysAgo(56)));
  if (points.length === 0) {
    throw new Error("CFTC TFF returned no rows for the trailing 8 weeks -- source format or contract codes may have changed");
  }
  return points;
}

/** Backfill: full TFF history (starts June 2006). */
export async function fetchCftcBackfill(): Promise<DataPoint[]> {
  return toDataPoints(await fetchTffSince("2006-01-01"));
}
