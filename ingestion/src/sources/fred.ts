import type { DataPoint } from "../lib/supabase.js";

// FRED API is stable and well documented: https://fred.stlouisfed.org/docs/api/fred/
// Series IDs below match the exact list in reference_docs/crash-check-system-build-spec.md
// (Stage 2 bullet) plus VIXCLS, which is the natural free source for the VIX
// reading used in the indicator panel (indicator #1).
const FRED_SERIES: { id: string; unit: string }[] = [
  { id: "VIXCLS", unit: "index" },       // CBOE Volatility Index
  { id: "BAMLH0A0HYM2", unit: "percent" }, // ICE BofA US High Yield OAS — FRED reports this in
                                          // percent (e.g. 2.90 = 290bps); the rule engine converts
                                          // to bps to match the indicator band units.
  { id: "DGS10", unit: "percent" },      // 10yr Treasury yield
  { id: "DGS2", unit: "percent" },       // 2yr Treasury yield
  { id: "DGS30", unit: "percent" },      // 30yr Treasury yield
  { id: "STLFSI4", unit: "index" },      // St. Louis Fed Financial Stress Index
  { id: "NFCI", unit: "index" },         // Chicago Fed National Financial Conditions Index
  { id: "T10YIE", unit: "percent" },     // 10yr breakeven inflation
  { id: "DRTSCILM", unit: "percent" },   // Senior Loan Officer Survey — C&I lending standards, large/medium firms
  { id: "RRPONTSYD", unit: "usd_billions" }, // Overnight reverse repo
  { id: "CPIAUCSL", unit: "index" },     // CPI, all urban consumers, headline
  { id: "UNRATE", unit: "percent" },     // Unemployment rate
  { id: "SAHMREALTIME", unit: "ratio" }, // Real-time Sahm Rule recession indicator

  // Track A additions — contextual/supplementary indicators (informational
  // only, not part of the 6-indicator wave-authorization gate; see
  // reference_docs/rules/crash-check-rules.md "Contextual Indicators").
  { id: "ICSA", unit: "count" },         // Initial jobless claims, weekly
  { id: "DRCCLACBS", unit: "percent" },  // Credit card delinquency rate, all commercial banks
  { id: "DCOILWTICO", unit: "usd" },     // WTI crude oil, $/barrel — automates the existing
                                          // "Brent/WTI above $100 = stagflation accelerant" line
                                          // in crash-check-rules.md's Recovery/Complacency bands.
  { id: "RSAFS", unit: "usd_millions" }, // Advance retail sales, all stores — closest free proxy
                                          // to "consumer/credit-card spending"; FRED has no public
                                          // real-time card-swipe series, this is reported monthly.

  // CAD/USD FX rate for the RRSP's local_state/portfolio.yaml conversion —
  // was a hand-updated snapshot before this; see get_portfolio_snapshot in
  // mcp_server, which reads this series live instead of trusting the
  // hardcoded value. Units: Canadian dollars per 1 US dollar (e.g. 1.42) —
  // the CAD->USD rate used for value_usd is 1/DEXCAUS, computed at read time.
  { id: "DEXCAUS", unit: "cad_per_usd" },
];

interface FredObservation {
  date: string;
  value: string;
}

interface FredResponse {
  observations: FredObservation[];
}

// fetchFred() makes ~17 sequential requests per run; a bare fetch() means any
// single transient 5xx/network blip anywhere in that sequence aborts the
// entire FRED fetch (see fetchFred()'s atomic loop below), losing series that
// already succeeded too. Retries only 5xx/network errors — a 4xx (bad series
// ID, bad key) is a real bug and should still fail immediately, not be masked
// by retrying it.
const RETRY_DELAYS_MS = [500, 1500, 4000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(url: string): Promise<Response> {
  let lastError: Error = new Error("fetchWithRetry: unreachable");
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status < 500) return res;
      lastError = new Error(`HTTP ${res.status} ${await res.text()}`);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
    if (attempt < RETRY_DELAYS_MS.length) await sleep(RETRY_DELAYS_MS[attempt]);
  }
  throw lastError;
}

async function fetchLatestObservation(seriesId: string, apiKey: string): Promise<FredObservation> {
  const url = new URL("https://api.stlouisfed.org/fred/series/observations");
  url.searchParams.set("series_id", seriesId);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("file_type", "json");
  url.searchParams.set("sort_order", "desc");
  // FRED sometimes reports the most recent period as "." (not yet available) —
  // pull a few and take the first real value rather than assuming index 0 is valid.
  url.searchParams.set("limit", "5");

  const res = await fetchWithRetry(url.toString());
  if (!res.ok) {
    throw new Error(`FRED request failed for ${seriesId}: HTTP ${res.status} ${await res.text()}`);
  }

  const body = (await res.json()) as FredResponse;
  const observation = body.observations?.find((o) => o.value !== ".");
  if (!observation) {
    throw new Error(`FRED returned no usable observation for ${seriesId}`);
  }
  return observation;
}

// S&P drawdown-from-ATH is one of the 6 canonical indicators, but it needs
// two numbers FRED's "latest observation" pattern can't give us: today's
// level AND the running all-time-high. There's no "give me the max" FRED
// endpoint, so we fetch a multi-year window and compute both client-side.
// The window just needs to be long enough to contain the true ATH — FRED's
// SP500 series only goes back to 2013 anyway, and in a secular uptrend the
// ATH is usually recent, so this self-heals correctly on every run without
// needing a separate backfill step.
async function fetchSp500LevelAndAth(apiKey: string): Promise<DataPoint[]> {
  const url = new URL("https://api.stlouisfed.org/fred/series/observations");
  url.searchParams.set("series_id", "SP500");
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("file_type", "json");
  url.searchParams.set("observation_start", "2010-01-01");
  url.searchParams.set("sort_order", "asc");
  url.searchParams.set("limit", "100000");

  const res = await fetchWithRetry(url.toString());
  if (!res.ok) {
    throw new Error(`FRED request failed for SP500: HTTP ${res.status} ${await res.text()}`);
  }

  const body = (await res.json()) as FredResponse;
  const valid = body.observations?.filter((o) => o.value !== ".") ?? [];
  if (valid.length === 0) {
    throw new Error("FRED returned no usable SP500 observations");
  }

  const latest = valid[valid.length - 1];
  const ath = valid.reduce((max, o) => (Number(o.value) > Number(max.value) ? o : max), valid[0]);

  return [
    {
      series_id: "SP500",
      source: "FRED",
      source_series_code: "SP500",
      observation_date: latest.date,
      value: Number(latest.value),
      unit: "index",
      raw_payload: latest,
    },
    {
      // Derived, not a distinct FRED series — observation_date here is the
      // date the ATH was actually set, not today. Upserts idempotently on
      // (series_id, observation_date): stays a no-op update until a new
      // high actually prints, at which point the date moves forward.
      series_id: "SP500_ATH",
      source: "FRED_DERIVED",
      source_series_code: "SP500",
      observation_date: ath.date,
      value: Number(ath.value),
      unit: "index",
      raw_payload: { computed_from: "SP500 series max, 2010-present window", observation: ath },
    },
  ];
}

export async function fetchFred(): Promise<DataPoint[]> {
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) {
    throw new Error("FRED_API_KEY is not set");
  }

  const points: DataPoint[] = [];
  for (const series of FRED_SERIES) {
    const obs = await fetchLatestObservation(series.id, apiKey);
    points.push({
      series_id: series.id,
      source: "FRED",
      source_series_code: series.id,
      observation_date: obs.date,
      value: Number(obs.value),
      unit: series.unit,
      raw_payload: obs,
    });
  }

  points.push(...(await fetchSp500LevelAndAth(apiKey)));

  return points;
}
