import { type DataPoint, readWatchlistTickers } from "../lib/supabase.js";

// Alpha Vantage GLOBAL_QUOTE — daily close price for a single ticker.
// Free tier: 25 requests/day AND 5 requests/minute — the per-minute cap is
// the one that bites with a 7-ticker watchlist fired back-to-back, so
// fetchAlphaVantage() waits between requests (see REQUEST_SPACING_MS below).
//
// Ingestion runs in GitHub Actions and has no access to the local, gitignored
// local_state/brokeragelink_watchlist.yaml (that file only exists on the
// user's machine — see mcp_server for the read/write side). So the ticker
// *list* itself (symbols only — no targets/thesis/position sizing, which
// stay local-only) lives in Supabase's watchlist_tickers table instead,
// kept in sync by mcp_server's write_watchlist tool whenever the list
// changes — no manual step needed here.
const GLOBAL_QUOTE_URL = "https://www.alphavantage.co/query";
// 5 req/min free-tier cap => >=12s apart; 13s leaves margin for clock drift.
const REQUEST_SPACING_MS = 13000;

interface AlphaVantageQuote {
  "Global Quote": {
    "01. symbol": string;
    "05. price": string;
    "07. latest trading day": string;
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchQuote(symbol: string, apiKey: string): Promise<DataPoint | null> {
  const url = new URL(GLOBAL_QUOTE_URL);
  url.searchParams.set("function", "GLOBAL_QUOTE");
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("apikey", apiKey);

  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`Alpha Vantage request failed for ${symbol}: HTTP ${res.status} ${await res.text()}`);
  }

  const body = (await res.json()) as AlphaVantageQuote & { Note?: string; Information?: string };
  const quote = body["Global Quote"];
  if (!quote || !quote["05. price"]) {
    // Rate-limited responses come back HTTP 200 with a "Note"/"Information"
    // field instead of "Global Quote", instead of a real error status. Log
    // the actual message rather than silently returning null, so a rate
    // limit vs. a genuinely bad symbol are distinguishable in the Actions log.
    console.warn(`Alpha Vantage: no usable quote for ${symbol} — ${body.Note ?? body.Information ?? "empty response"}`);
    return null;
  }

  return {
    series_id: symbol,
    source: "ALPHA_VANTAGE",
    source_series_code: symbol,
    observation_date: quote["07. latest trading day"],
    value: Number(quote["05. price"]),
    unit: "usd",
    raw_payload: quote,
  };
}

export async function fetchAlphaVantage(): Promise<DataPoint[]> {
  const tickers = await readWatchlistTickers();
  if (tickers.length === 0) {
    return []; // optional source — nothing configured, nothing to fetch
  }

  const apiKey = process.env.ALPHA_VANTAGE_API_KEY;
  if (!apiKey) {
    throw new Error("watchlist_tickers has entries but ALPHA_VANTAGE_API_KEY is not set");
  }

  const points: DataPoint[] = [];
  for (let i = 0; i < tickers.length; i++) {
    if (i > 0) await sleep(REQUEST_SPACING_MS);
    const point = await fetchQuote(tickers[i], apiKey);
    if (point) points.push(point);
  }
  return points;
}

const TIME_SERIES_DAILY_URL = "https://www.alphavantage.co/query";
// outputsize=full (20+ years) is a premium-only feature on Alpha Vantage's
// free tier — confirmed live (returns a "premium feature" Information
// message, not data). outputsize=compact is the free-tier ceiling: the most
// recent ~100 trading days (~5 months), well short of fred.ts's 5-year
// BACKFILL_YEARS, but it's what's actually available without a paid plan.
const BACKFILL_YEARS = 5;

interface AlphaVantageDaily {
  "Time Series (Daily)"?: Record<string, { "4. close": string }>;
  Note?: string;
  Information?: string;
}

async function fetchDailyHistory(symbol: string, apiKey: string, cutoffDate: string): Promise<DataPoint[]> {
  const url = new URL(TIME_SERIES_DAILY_URL);
  url.searchParams.set("function", "TIME_SERIES_DAILY");
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("outputsize", "compact");
  url.searchParams.set("apikey", apiKey);

  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`Alpha Vantage backfill request failed for ${symbol}: HTTP ${res.status} ${await res.text()}`);
  }

  const body = (await res.json()) as AlphaVantageDaily;
  const series = body["Time Series (Daily)"];
  if (!series) {
    console.warn(`Alpha Vantage backfill: no data for ${symbol} — ${body.Note ?? body.Information ?? "empty response"}`);
    return [];
  }

  return Object.entries(series)
    .filter(([date]) => date >= cutoffDate)
    .map(([date, day]) => ({
      series_id: symbol,
      source: "ALPHA_VANTAGE",
      source_series_code: symbol,
      observation_date: date,
      value: Number(day["4. close"]),
      unit: "usd",
      raw_payload: day,
    }));
}

export async function fetchAlphaVantageBackfill(): Promise<DataPoint[]> {
  const tickers = await readWatchlistTickers();
  if (tickers.length === 0) {
    return [];
  }

  const apiKey = process.env.ALPHA_VANTAGE_API_KEY;
  if (!apiKey) {
    throw new Error("watchlist_tickers has entries but ALPHA_VANTAGE_API_KEY is not set");
  }

  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - BACKFILL_YEARS);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const points: DataPoint[] = [];
  for (let i = 0; i < tickers.length; i++) {
    if (i > 0) await sleep(REQUEST_SPACING_MS);
    const history = await fetchDailyHistory(tickers[i], apiKey, cutoffStr);
    points.push(...history);
    console.log(`  Alpha Vantage backfill: ${tickers[i]} — ${history.length} observations since ${cutoffStr}`);
  }
  return points;
}
