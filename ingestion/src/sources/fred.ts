import type { DataPoint } from "../lib/supabase.js";

// FRED API is stable and well documented: https://fred.stlouisfed.org/docs/api/fred/
// Series IDs below match the exact list in reference_docs/crash-check-system-build-spec.md
// (Stage 2 bullet) plus VIXCLS, which is the natural free source for the VIX
// reading used in the indicator panel (indicator #1).
const FRED_SERIES: { id: string; unit: string }[] = [
  { id: "VIXCLS", unit: "index" },       // CBOE Volatility Index
  { id: "BAMLH0A0HYM2", unit: "bps" },   // ICE BofA US High Yield OAS
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
  return points;
}
