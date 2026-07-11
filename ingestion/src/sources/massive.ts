import { type DataPoint, readWatchlistTickers } from "../lib/supabase.js";

// Massive (massive.com) — replaces Alpha Vantage as the watchlist ticker
// price source. Confirmed live 2026-07-11: free tier is 5 req/min with no
// documented daily cap (vs. Alpha Vantage's 25/day), 2yr historical range
// data is genuinely free-tier (Alpha Vantage's equivalent turned out to be
// premium-gated despite being advertised), and there's a "grouped daily"
// endpoint that returns the whole US market for one date in a single
// request — so the recurring daily job needs exactly ONE call regardless
// of watchlist size, not one per ticker.
const BASE_URL = "https://api.massive.com";
// 5 req/min free-tier cap => >=12s apart; 13s leaves margin for clock drift.
// Only relevant to the backfill path (one request per ticker); the daily
// path is a single grouped-daily request, no spacing needed.
const REQUEST_SPACING_MS = 13000;
const BACKFILL_YEARS = 2; // matches Massive's advertised free-tier historical depth

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toDateString(unixMs: number): string {
  return new Date(unixMs).toISOString().slice(0, 10);
}

interface MassiveBar {
  T?: string; // ticker symbol — present on grouped-daily results, absent on per-ticker range results
  c: number; // close
  t: number; // unix ms
}

interface MassiveAggsResponse {
  results?: MassiveBar[];
  status?: string;
}

// Walks back from yesterday (UTC calendar day) to find the most recent
// trading day with published data — handles weekends/holidays without
// needing a market calendar, same pattern as fred.ts skipping "." placeholders.
async function fetchLatestGroupedDaily(apiKey: string): Promise<MassiveBar[]> {
  const maxLookbackDays = 7;
  for (let daysAgo = 1; daysAgo <= maxLookbackDays; daysAgo++) {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() - daysAgo);
    const dateStr = date.toISOString().slice(0, 10);

    const url = new URL(`${BASE_URL}/v2/aggs/grouped/locale/us/market/stocks/${dateStr}`);
    url.searchParams.set("apiKey", apiKey);

    const res = await fetch(url.toString());
    if (!res.ok) {
      throw new Error(`Massive grouped-daily request failed for ${dateStr}: HTTP ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as MassiveAggsResponse;
    if (body.results && body.results.length > 0) {
      return body.results;
    }
  }
  throw new Error(`Massive: no grouped-daily data found in the last ${maxLookbackDays} days`);
}

export async function fetchMassive(): Promise<DataPoint[]> {
  const tickers = await readWatchlistTickers();
  if (tickers.length === 0) {
    return []; // optional source — nothing configured, nothing to fetch
  }

  const apiKey = process.env.MASSIVE_API_KEY;
  if (!apiKey) {
    throw new Error("watchlist_tickers has entries but MASSIVE_API_KEY is not set");
  }

  const tickerSet = new Set(tickers);
  const allResults = await fetchLatestGroupedDaily(apiKey);

  return allResults
    .filter((bar) => bar.T && tickerSet.has(bar.T))
    .map((bar) => ({
      series_id: bar.T!,
      source: "MASSIVE",
      source_series_code: bar.T!,
      observation_date: toDateString(bar.t),
      value: bar.c,
      unit: "usd",
      raw_payload: bar,
    }));
}

async function fetchTickerRange(symbol: string, apiKey: string, from: string, to: string): Promise<DataPoint[]> {
  const url = new URL(`${BASE_URL}/v2/aggs/ticker/${symbol}/range/1/day/${from}/${to}`);
  url.searchParams.set("apiKey", apiKey);
  url.searchParams.set("sort", "asc");
  url.searchParams.set("limit", "5000");

  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`Massive backfill request failed for ${symbol}: HTTP ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as MassiveAggsResponse;

  return (body.results ?? []).map((bar) => ({
    series_id: symbol,
    source: "MASSIVE",
    source_series_code: symbol,
    observation_date: toDateString(bar.t),
    value: bar.c,
    unit: "usd",
    raw_payload: bar,
  }));
}

export async function fetchMassiveBackfill(): Promise<DataPoint[]> {
  const tickers = await readWatchlistTickers();
  if (tickers.length === 0) {
    return [];
  }

  const apiKey = process.env.MASSIVE_API_KEY;
  if (!apiKey) {
    throw new Error("watchlist_tickers has entries but MASSIVE_API_KEY is not set");
  }

  const from = new Date();
  from.setFullYear(from.getFullYear() - BACKFILL_YEARS);
  const fromStr = from.toISOString().slice(0, 10);
  const toStr = new Date().toISOString().slice(0, 10);

  const points: DataPoint[] = [];
  for (let i = 0; i < tickers.length; i++) {
    if (i > 0) await sleep(REQUEST_SPACING_MS);
    const history = await fetchTickerRange(tickers[i], apiKey, fromStr, toStr);
    points.push(...history);
    console.log(`  Massive backfill: ${tickers[i]} — ${history.length} observations since ${fromStr}`);
  }
  return points;
}
