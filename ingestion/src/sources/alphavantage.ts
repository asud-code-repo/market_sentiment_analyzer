import type { DataPoint } from "../lib/supabase.js";

// Alpha Vantage GLOBAL_QUOTE — daily close price for a single ticker.
// Free tier: 25 requests/day, well within reach for a handful of watchlist
// tickers pulled once daily.
//
// Ingestion runs in GitHub Actions and has no access to the local, gitignored
// local_state/brokeragelink_watchlist.yaml (that file only exists on the
// user's machine — see mcp_server for the read/write side). So the ticker
// *list* itself is configured via the WATCHLIST_TICKERS repo variable
// (comma-separated symbols, same optional-config pattern as
// POLYMARKET_SLUGS) — only the resulting *prices* land in Supabase's
// data_points, same as any other public market series (e.g. SP500). Price
// targets, thesis notes, and position sizing stay local-only.
const GLOBAL_QUOTE_URL = "https://www.alphavantage.co/query";

interface AlphaVantageQuote {
  "Global Quote": {
    "01. symbol": string;
    "05. price": string;
    "07. latest trading day": string;
  };
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

  const body = (await res.json()) as AlphaVantageQuote;
  const quote = body["Global Quote"];
  if (!quote || !quote["05. price"]) {
    // Rate-limited responses come back HTTP 200 with an empty/Note payload
    // instead of a real error status — treat "no usable quote" as a skip for
    // this one symbol rather than failing the whole optional source.
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
  const tickersRaw = process.env.WATCHLIST_TICKERS?.trim();
  if (!tickersRaw) {
    return []; // optional source — nothing configured, nothing to fetch
  }

  const apiKey = process.env.ALPHA_VANTAGE_API_KEY;
  if (!apiKey) {
    throw new Error("WATCHLIST_TICKERS is set but ALPHA_VANTAGE_API_KEY is not");
  }

  const tickers = tickersRaw.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  const points: DataPoint[] = [];
  for (const symbol of tickers) {
    const point = await fetchQuote(symbol, apiKey);
    if (point) points.push(point);
  }
  return points;
}
