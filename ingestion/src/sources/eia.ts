import type { DataPoint } from "../lib/supabase.js";

// EIA API v2. Route confirmed live (returns API_KEY_MISSING, not 404) at
// https://api.eia.gov/v2/petroleum/pri/spt/data/ — verified 2026-07-09.
// Series facet "RWTC" (WTI Cushing spot price) is the long-standing EIA
// series ID for this data; double-check it once you have a key by hitting
// https://api.eia.gov/v2/petroleum/pri/spt/data/?api_key=YOUR_KEY&facets[series][]=RWTC&length=1
// — if the facet is wrong, EIA returns a clear "invalid facet value" error
// rather than silently returning nothing.
const EIA_SERIES: { facet: string; seriesId: string; unit: string }[] = [
  { facet: "RWTC", seriesId: "EIA_WTI_SPOT", unit: "usd_per_barrel" },
];

interface EiaDataRow {
  period: string;
  value: string;
}

interface EiaResponse {
  response: {
    data: EiaDataRow[];
  };
}

async function fetchLatestSpotPrice(facet: string, apiKey: string): Promise<EiaDataRow> {
  const url = new URL("https://api.eia.gov/v2/petroleum/pri/spt/data/");
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("frequency", "weekly");
  url.searchParams.append("data[0]", "value");
  url.searchParams.append("facets[series][]", facet);
  url.searchParams.set("sort[0][column]", "period");
  url.searchParams.set("sort[0][direction]", "desc");
  url.searchParams.set("length", "1");

  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`EIA request failed for series ${facet}: HTTP ${res.status} ${await res.text()}`);
  }

  const body = (await res.json()) as EiaResponse;
  const row = body.response?.data?.[0];
  if (!row) {
    throw new Error(`EIA returned no data for series ${facet}`);
  }
  return row;
}

export async function fetchEia(): Promise<DataPoint[]> {
  const apiKey = process.env.EIA_API_KEY;
  if (!apiKey) {
    throw new Error("EIA_API_KEY is not set");
  }

  const points: DataPoint[] = [];
  for (const series of EIA_SERIES) {
    const row = await fetchLatestSpotPrice(series.facet, apiKey);
    points.push({
      series_id: series.seriesId,
      source: "EIA",
      source_series_code: series.facet,
      observation_date: row.period,
      value: Number(row.value),
      unit: series.unit,
      raw_payload: row,
    });
  }
  return points;
}
