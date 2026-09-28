import type { DataPoint } from "../lib/supabase.js";

// VIX source, replacing FRED's VIXCLS (2026-09-28). FRED's own VIXCLS series
// (sourced from CBOE) was found stuck at 2026-09-22 for 4+ business days
// while the ingest itself was healthy every day — verified against FRED's
// own public CSV directly, not just our database, so this was a genuine
// upstream publication gap, not an ingestion bug (see BACKLOG.md). Yahoo's
// unofficial chart API carries the same underlying CBOE VIX value same-day
// (cross-checked: matches FRED's own 2026-09-22 reading exactly) without
// FRED's extra lag. Kept under the existing "VIXCLS" series_id — every
// downstream reader (rule_engine, mcp_server, dashboard) keys off that ID,
// not the source, so nothing else needed to change.
//
// This is an unofficial, undocumented Yahoo endpoint (no API key, no formal
// support commitment) — same free-tier-without-a-contract tradeoff this
// project already accepts for Massive/SSGA/CBOE/GPR/TIC. It can change
// shape or start rate-limiting without notice; if it ever does, VIX is
// still one of the 6 gating indicators, so it's wired as `required: true`
// in ingest.ts (a broken VIX feed should fail loudly, not silently degrade).
const YAHOO_VIX_SYMBOL = "%5EVIX"; // ^VIX, URL-encoded

interface YahooChartResult {
  chart: {
    result?: {
      timestamp: number[];
      indicators: { quote: { close: (number | null)[] }[] };
    }[];
    error?: { code: string; description: string };
  };
}

const RETRY_DELAYS_MS = [500, 1500, 4000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(url: string): Promise<Response> {
  let lastError: Error = new Error("fetchWithRetry: unreachable");
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      // A User-Agent header is required — Yahoo's chart endpoint rejects
      // default fetch/curl UAs with a 429/999 on this unofficial API.
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (res.ok || res.status < 500) return res;
      lastError = new Error(`HTTP ${res.status} ${await res.text()}`);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
    if (attempt < RETRY_DELAYS_MS.length) await sleep(RETRY_DELAYS_MS[attempt]);
  }
  throw lastError;
}

// timestamp -> observation_date: Yahoo's daily-bar timestamps land in the
// early UTC morning for US-exchange data (verified: matches FRED's own
// trading-date convention exactly for the same closes), so a plain UTC
// calendar-date slice is safe here without needing exchange-timezone math.
function toObservationDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

async function fetchVixSeries(rangeOrPeriod: string): Promise<{ date: string; close: number }[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${YAHOO_VIX_SYMBOL}?${rangeOrPeriod}&interval=1d`;
  const res = await fetchWithRetry(url);
  if (!res.ok) {
    throw new Error(`Yahoo VIX request failed: HTTP ${res.status} ${await res.text()}`);
  }

  const body = (await res.json()) as YahooChartResult;
  if (body.chart.error) {
    throw new Error(`Yahoo VIX request returned an error: ${body.chart.error.description}`);
  }
  const result = body.chart.result?.[0];
  if (!result) {
    throw new Error("Yahoo VIX request returned no usable result");
  }

  const closes = result.indicators.quote[0]?.close ?? [];
  const points: { date: string; close: number }[] = [];
  for (let i = 0; i < result.timestamp.length; i++) {
    const close = closes[i];
    if (close === null || close === undefined) continue; // holiday/partial-bar gap
    points.push({ date: toObservationDate(result.timestamp[i]), close });
  }
  return points;
}

export async function fetchYahoo(): Promise<DataPoint[]> {
  // Last 10 calendar days is plenty of margin to guarantee at least one
  // real trading day is present regardless of weekends/holidays; only the
  // latest is kept, matching fetchFred's "latest observation" pattern.
  const series = await fetchVixSeries("range=10d");
  if (series.length === 0) {
    throw new Error("Yahoo VIX request returned no observations in the last 10 days");
  }
  const latest = series[series.length - 1];

  return [
    {
      series_id: "VIXCLS",
      source: "YAHOO",
      source_series_code: "^VIX",
      observation_date: latest.date,
      value: latest.close,
      unit: "index",
      raw_payload: latest,
    },
  ];
}

export async function fetchYahooBackfill(): Promise<DataPoint[]> {
  // Explicit period1=0 (epoch) with interval=1d returns true daily
  // resolution back to VIX's actual 1990 inception (verified: 9,585
  // observations 1990-01-02 to today, matching real trading-day density) —
  // Yahoo's range=max/5y shorthand silently buckets old history down to a
  // sparser cadence instead, which would leave big backfill gaps.
  const period2 = Math.floor(Date.now() / 1000);
  const series = await fetchVixSeries(`period1=0&period2=${period2}`);
  console.log(`  Yahoo backfill: VIXCLS — ${series.length} observations since ${series[0]?.date ?? "n/a"}`);

  return series.map((obs) => ({
    series_id: "VIXCLS",
    source: "YAHOO",
    source_series_code: "^VIX",
    observation_date: obs.date,
    value: obs.close,
    unit: "index",
    raw_payload: obs,
  }));
}
