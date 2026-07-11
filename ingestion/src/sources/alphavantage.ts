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
