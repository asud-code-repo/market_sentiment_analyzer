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

// Tracked for the small-cap/large-cap breadth signal (get_context_indicators),
// independent of the BrokerageLink watchlist -- never touched by
// write_watchlist's full-replacement sync (syncWatchlistTickers deletes any
// symbol not in its caller-supplied list every Portfolio Opportunity Review),
// so these can't be silently wiped out by that path.
//
// RSP (equal-weight S&P) and KRE (regional banks) added 2026-09-23 — same
// relative-return-spread-vs-SPY pattern as IWM: RSP catches narrow-leadership
// risk, KRE catches credit-sector-specific stress (2023 regional-bank crisis).
const BREADTH_TICKERS = ["IWM", "SPY", "RSP", "KRE"];

// Tracked for the gold contextual indicator (get_context_indicators) —
// gold already has a real allocation in the Type C/Type E crash-type
// sleeves (crash-check-rules.md), but its live price was never actually
// tracked anywhere until now. Same independent-of-watchlist rationale as
// BREADTH_TICKERS above. GLD is a normal US-listed ETF, so it flows through
// the same stocks grouped-daily endpoint as everything else here.
//
// SLV added 2026-09-22, deliberately NOT surfaced as its own standalone
// contextual indicator the way GLD is -- it exists only to feed the
// gold_vs_silver divergence pair (rule_engine/src/divergence.ts). Silver
// alone has no tied decision/narrative in this system (unlike gold's real
// Type C/E sleeve allocation), so a bare silver price line would be exactly
// the kind of isolated, noise-adding indicator this system avoids -- the
// gold/silver RATIO (a genuine flight-to-safety read) is the meaningful
// signal, not either metal's price level on its own.
const CONTEXT_TICKERS = ["GLD", "SLV"];

// Bitcoin, tracked as a secondary/awareness-only indicator (2026-09-14
// decision, made after verifying — not assuming — that BTC is NOT a
// reliable crash hedge: it fell MORE than equities in both the March 2020
// COVID crash and the 2022 bear market). Crypto is a separate Massive
// locale/market from stocks (confirmed via Massive's own REST docs), hence
// its own ticker list and its own fetch path below rather than folding into
// CONTEXT_TICKERS.
const CRYPTO_CONTEXT_TICKERS = ["X:BTCUSD"];

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

// Crypto is a separate Massive locale/market from stocks — same
// walk-back-to-find-a-published-date shape as fetchLatestGroupedDaily above,
// just a different URL. Crypto trades every day, so this will normally
// resolve on the first try; the defensive lookback loop costs nothing to
// reuse.
async function fetchLatestGroupedDailyCrypto(apiKey: string): Promise<MassiveBar[]> {
  const maxLookbackDays = 7;
  for (let daysAgo = 1; daysAgo <= maxLookbackDays; daysAgo++) {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() - daysAgo);
    const dateStr = date.toISOString().slice(0, 10);

    const url = new URL(`${BASE_URL}/v2/aggs/grouped/locale/global/market/crypto/${dateStr}`);
    url.searchParams.set("apiKey", apiKey);

    const res = await fetch(url.toString());
    if (!res.ok) {
      throw new Error(`Massive crypto grouped-daily request failed for ${dateStr}: HTTP ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as MassiveAggsResponse;
    if (body.results && body.results.length > 0) {
      return body.results;
    }
  }
  throw new Error(`Massive: no crypto grouped-daily data found in the last ${maxLookbackDays} days`);
}

export async function fetchMassive(): Promise<DataPoint[]> {
  const watchlistTickers = await readWatchlistTickers();
  const tickers = [...new Set([...watchlistTickers, ...BREADTH_TICKERS, ...CONTEXT_TICKERS])];
  if (tickers.length === 0) {
    return []; // optional source — nothing configured, nothing to fetch
  }

  const apiKey = process.env.MASSIVE_API_KEY;
  if (!apiKey) {
    throw new Error("watchlist_tickers has entries but MASSIVE_API_KEY is not set");
  }

  const tickerSet = new Set(tickers);
  const allResults = await fetchLatestGroupedDaily(apiKey);

  const stockPoints = allResults
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

  // Isolated: BTC is explicitly a secondary, awareness-only indicator (not
  // load-bearing the way watchlist tickers and GLD are), so a crypto-endpoint
  // failure shouldn't take down the whole ingestion run over it.
  let cryptoPoints: DataPoint[] = [];
  try {
    const cryptoTickerSet = new Set(CRYPTO_CONTEXT_TICKERS);
    const cryptoResults = await fetchLatestGroupedDailyCrypto(apiKey);
    cryptoPoints = cryptoResults
      .filter((bar) => bar.T && cryptoTickerSet.has(bar.T))
      .map((bar) => ({
        series_id: bar.T!,
        source: "MASSIVE",
        source_series_code: bar.T!,
        observation_date: toDateString(bar.t),
        value: bar.c,
        unit: "usd",
        raw_payload: bar,
      }));
  } catch (err) {
    console.warn(`Massive crypto fetch failed, continuing without it: ${(err as Error).message}`);
  }

  return [...stockPoints, ...cryptoPoints];
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
  const watchlistTickers = await readWatchlistTickers();
  // fetchTickerRange is ticker-symbol-generic (asset class is encoded in the
  // symbol itself, e.g. crypto's "X:" prefix), so CRYPTO_CONTEXT_TICKERS
  // rides the same per-ticker loop below as everything else — no separate
  // crypto backfill function, unlike the daily grouped-endpoint path above.
  // Unverified assumption: first real backfill run is the actual check.
  const tickers = [...new Set([...watchlistTickers, ...BREADTH_TICKERS, ...CONTEXT_TICKERS, ...CRYPTO_CONTEXT_TICKERS])];
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
