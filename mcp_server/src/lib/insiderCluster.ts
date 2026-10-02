import { supabase } from "./supabase.js";

// Insider Form 4 cluster-buy signal (backlog: 13F/insider positioning
// discussion) -- the "forward view" half, companion to sectorRotation.ts's
// institutional_13f_* fields (the "confirm the past" half). Tier 2/
// informational only, never gates wave authorization -- see
// crash-check-rules.md's Layer Boundary rule.
const CLUSTER_WINDOW_DAYS = 30;

export interface InsiderSignal {
  ticker: string;
  distinct_officer_director_buyers_30d: number;
  cluster_buy_signal: boolean; // >= 2 distinct officer/director open-market buyers in the trailing 30 days
  total_buy_usd_30d: number | null;
  total_sell_count_30d: number; // count only, deliberately no dollar figure attached -- see note below
  latest_transaction_date: string | null;
}

interface InsiderRow {
  ticker: string;
  owner_cik: string;
  is_officer: boolean;
  is_director: boolean;
  transaction_code: string;
  shares: number;
  price_per_share: number | null;
  transaction_date: string;
}

function subtractDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * Reads insider_transactions for the current BrokerageLink watchlist over
 * the trailing 30 days and computes a per-ticker cluster-buy flag --
 * cluster = 2+ DISTINCT officers/directors buying in the open market
 * (transaction_code='P'), not any single buy and not a raw count of
 * transactions (one person placing several small buys isn't the same
 * signal as several different insiders independently deciding to buy).
 * 10%-owner-only purchases are excluded from the cluster count (a passive
 * holder crossing the 10% threshold is a different signal than operating
 * insiders buying) but still visible in the underlying table for drill-down.
 *
 * Sell activity is reported as a count only, deliberately with no dollar
 * figure and no "bearish" framing -- insider selling is dominated by
 * 10b5-1 scheduled plans, tax timing, and diversification, none of which
 * carry the same signal value as insider buying. Rows already filtered at
 * ingest to exclude is_10b5_1=true (see ingestion/src/sources/secForm4.ts).
 */
export async function computeInsiderClusterSignals(): Promise<InsiderSignal[]> {
  const { data: watchlist, error: watchlistError } = await supabase.from("watchlist_tickers").select("symbol");
  if (watchlistError) {
    throw new Error(`Failed to read watchlist_tickers: ${watchlistError.message}`);
  }
  const tickers = (watchlist ?? []).map((row) => row.symbol as string);
  if (tickers.length === 0) return [];

  const cutoff = subtractDays(new Date().toISOString().slice(0, 10), CLUSTER_WINDOW_DAYS);
  const { data, error } = await supabase
    .from("insider_transactions")
    .select("ticker, owner_cik, is_officer, is_director, transaction_code, shares, price_per_share, transaction_date")
    .in("ticker", tickers)
    .gte("transaction_date", cutoff);

  if (error) {
    throw new Error(`Failed to read insider_transactions: ${error.message}`);
  }
  const rows = (data ?? []) as InsiderRow[];

  return tickers.map((ticker) => {
    const tickerRows = rows.filter((r) => r.ticker === ticker);
    const buys = tickerRows.filter((r) => r.transaction_code === "P");
    const sells = tickerRows.filter((r) => r.transaction_code === "S");

    const clusterBuyers = new Set(buys.filter((r) => r.is_officer || r.is_director).map((r) => r.owner_cik));

    const buyUsdValues = buys
      .filter((r) => r.price_per_share != null)
      .map((r) => r.shares * (r.price_per_share as number));
    const totalBuyUsd = buyUsdValues.length > 0 ? Math.round(buyUsdValues.reduce((sum, v) => sum + v, 0)) : null;

    const latestDate = tickerRows.length > 0
      ? tickerRows.map((r) => r.transaction_date).sort().at(-1) ?? null
      : null;

    return {
      ticker,
      distinct_officer_director_buyers_30d: clusterBuyers.size,
      cluster_buy_signal: clusterBuyers.size >= 2,
      total_buy_usd_30d: totalBuyUsd,
      total_sell_count_30d: sells.length,
      latest_transaction_date: latestDate,
    };
  });
}
