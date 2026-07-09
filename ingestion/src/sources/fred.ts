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
];

interface FredObservation {
  date: string;
  value: string;
}

interface FredResponse {
  observations: FredObservation[];
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

  const res = await fetch(url.toString());
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

  const res = await fetch(url.toString());
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
