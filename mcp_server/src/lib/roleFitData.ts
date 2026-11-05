// Data for the report-only role-fit metrics (roleFit.ts). Fetched on demand
// from the MCP server, never persisted: instrument tickers stay on this
// machine (they're the plan menu), and only public benchmark/breakeven data
// comes from Supabase. Yahoo's chart API covers both ETFs and mutual-fund
// share classes (the proxies); adjusted closes include distributions.

import { supabase } from "./supabase.js";
import type { PriceSeries } from "./roleFit.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface YahooChart {
  chart: {
    result?: {
      timestamp?: number[];
      indicators: { quote: { close: (number | null)[] }[]; adjclose?: { adjclose: (number | null)[] }[] };
    }[];
    error?: { description: string } | null;
  };
}

export async function fetchYahooDaily(symbol: string, range = "5y"): Promise<PriceSeries> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d`;
  let lastErr = "";
  for (const backoff of [0, 1000, 3000]) {
    await sleep(200 + backoff);
    // Yahoo's unofficial endpoint rejects default fetch UAs (same as ingestion/src/sources/yahoo.ts).
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) {
      lastErr = `HTTP ${res.status}`;
      if (res.status !== 429 && res.status < 500) break;
      continue;
    }
    const body = (await res.json()) as YahooChart;
    const r = body.chart.result?.[0];
    if (!r?.timestamp) throw new Error(`Yahoo returned no data for ${symbol}: ${body.chart.error?.description ?? "empty"}`);
    const closes = r.indicators.adjclose?.[0]?.adjclose ?? r.indicators.quote[0].close;
    const out: PriceSeries = new Map();
    r.timestamp.forEach((ts, i) => {
      const v = closes[i];
      if (typeof v === "number" && v > 0) out.set(new Date(ts * 1000).toISOString().slice(0, 10), v);
    });
    return out;
  }
  throw new Error(`Yahoo fetch failed for ${symbol}: ${lastErr}`);
}

export async function fetchSeriesHistory(seriesId: string, days = 1900): Promise<PriceSeries> {
  const { data, error } = await supabase
    .from("data_points")
    .select("observation_date, value")
    .eq("series_id", seriesId)
    .order("observation_date", { ascending: false })
    .limit(days);
  if (error) throw new Error(`Failed to read ${seriesId} history: ${error.message}`);
  return new Map((data ?? []).map((r) => [r.observation_date as string, r.value as number]));
}
