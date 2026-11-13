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
const YAHOO_VIX_SYMBOL = "^VIX";

interface YahooChartResult {
  chart: {
    result?: {
      meta?: { currentTradingPeriod?: { regular?: { start: number; end: number } } };
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

// Settle buffer after the regular session ends before a same-day bar is
// treated as a final close (VIX's own official close prints at 4:15pm ET,
// 15 minutes after the equity close).
const CLOSE_SETTLE_SECONDS = 30 * 60;

/**
 * Daily bars from Yahoo's chart API, COMPLETED SESSIONS ONLY.
 *
 * While the market is open, Yahoo's last daily bar is the in-progress
 * session, and its "close" is just the latest intraday price. The 10am-ET
 * ingest used to store that bar as the day's close and never correct it:
 * a 2026-11-09 audit found 22 of 40 VIXCLS rows since the switch to Yahoo
 * were morning snapshots (e.g. 2026-11-05 stored 24.31 vs a 28.18 close).
 * So any bar whose session hasn't ended (plus a settle buffer) is dropped.
 * The rule engine, the 6-indicator bands and the hazard model all assume
 * closes, and the scheduled 2pm-ET analysis runs mid-session anyway, so
 * the previous session's close is the freshest real close available.
 */
export async function fetchYahooDailyCloses(
  symbol: string,
  rangeOrPeriod: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<{ date: string; close: number }[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?${rangeOrPeriod}&interval=1d`;
  const res = await fetchWithRetry(url);
  if (!res.ok) {
    throw new Error(`Yahoo ${symbol} request failed: HTTP ${res.status} ${await res.text()}`);
  }

  const body = (await res.json()) as YahooChartResult;
  if (body.chart.error) {
    throw new Error(`Yahoo ${symbol} request returned an error: ${body.chart.error.description}`);
  }
  const result = body.chart.result?.[0];
  if (!result) {
    throw new Error(`Yahoo ${symbol} request returned no usable result`);
  }

  // The current/most recent session's window. If it hasn't finished
  // (plus settle buffer), the bar stamped inside it is still in progress.
  const session = result.meta?.currentTradingPeriod?.regular;
  if (!session) {
    throw new Error(`Yahoo ${symbol} response is missing currentTradingPeriod — can't tell a final close from an intraday bar`);
  }
  const sessionOpen = nowSeconds < session.end + CLOSE_SETTLE_SECONDS;

  const closes = result.indicators.quote[0]?.close ?? [];
  const points: { date: string; close: number }[] = [];
  for (let i = 0; i < result.timestamp.length; i++) {
    const close = closes[i];
    if (close === null || close === undefined) continue; // holiday/partial-bar gap
    if (sessionOpen && result.timestamp[i] >= session.start) continue; // in-progress session
    points.push({ date: toObservationDate(result.timestamp[i]), close });
  }
  return points;
}

export async function fetchYahoo(): Promise<DataPoint[]> {
  // Trailing ~3 months of completed closes, not just the latest: re-writing
  // recent days is an idempotent upsert on (series_id, observation_date),
  // and it overwrites any intraday snapshot stored before the
  // completed-sessions-only fix (see fetchYahooDailyCloses).
  const series = await fetchYahooDailyCloses(YAHOO_VIX_SYMBOL, "range=3mo");
  if (series.length === 0) {
    throw new Error("Yahoo VIX request returned no completed sessions in the last 3 months");
  }

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

// ICE BofA MOVE index (Treasury implied volatility, the bond-market analog
// to VIX), added 2026-11-13 (E2; crash-check-rules.md "Bond volatility
// (MOVE)"). Previously rejected because Yahoo's endpoint is unofficial —
// but VIX already depends on this same endpoint, so that objection no
// longer stands on its own; the shared-dependency risk is accepted and
// documented in the rules doc. Unlike VIX, MOVE is context-only, so it is
// wired as an OPTIONAL source in ingest.ts: a failure logs a warning and
// the tool reports the last stored value (or null), never failing the run.
// Yahoo serves daily ^MOVE closes from 2002-11-12.
const YAHOO_MOVE_SYMBOL = "^MOVE";

function toMovePoint(obs: { date: string; close: number }): DataPoint {
  return {
    series_id: "MOVE",
    source: "YAHOO",
    source_series_code: YAHOO_MOVE_SYMBOL,
    observation_date: obs.date,
    value: obs.close,
    unit: "index",
    raw_payload: obs,
  };
}

export async function fetchYahooMove(): Promise<DataPoint[]> {
  const series = await fetchYahooDailyCloses(YAHOO_MOVE_SYMBOL, "range=3mo");
  if (series.length === 0) {
    throw new Error("Yahoo MOVE request returned no completed sessions in the last 3 months");
  }
  return series.map(toMovePoint);
}

export async function fetchYahooMoveBackfill(): Promise<DataPoint[]> {
  const period2 = Math.floor(Date.now() / 1000);
  const series = await fetchYahooDailyCloses(YAHOO_MOVE_SYMBOL, `period1=0&period2=${period2}`);
  console.log(`  Yahoo backfill: MOVE — ${series.length} observations since ${series[0]?.date ?? "n/a"}`);
  return series.map(toMovePoint);
}

export async function fetchYahooBackfill(): Promise<DataPoint[]> {
  // Explicit period1=0 (epoch) with interval=1d returns true daily
  // resolution back to VIX's actual 1990 inception (verified: 9,585
  // observations 1990-01-02 to today, matching real trading-day density) —
  // Yahoo's range=max/5y shorthand silently buckets old history down to a
  // sparser cadence instead, which would leave big backfill gaps.
  const period2 = Math.floor(Date.now() / 1000);
  const series = await fetchYahooDailyCloses(YAHOO_VIX_SYMBOL, `period1=0&period2=${period2}`);
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
