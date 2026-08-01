import { supabase, getLatestDataPoint } from "./supabase.js";

/**
 * 7-day calendar-day delta for a data_points series — mirrors
 * mcp_server/src/lib/seriesDelta.ts's computeSeriesDelta() (duplicated
 * rather than shared across the package boundary, same convention as
 * ConfirmationEntry elsewhere in this codebase). Only computes the 7-day
 * window, not 3-day too — this is purpose-built for divergence detection
 * (computeDivergences() below), not a general-purpose delta tool; the
 * MCP-server-side get_series_deltas remains the one for ad-hoc 3-day/7-day
 * queries from chat.
 */
function subtractDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

async function getValueOnOrBefore(seriesId: string, onOrBeforeDate: string): Promise<number | null> {
  const { data, error } = await supabase
    .from("data_points")
    .select("value")
    .eq("series_id", seriesId)
    .lte("observation_date", onOrBeforeDate)
    .order("observation_date", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to read historical data_point for ${seriesId} on/before ${onOrBeforeDate}: ${error.message}`);
  }
  return data?.value ?? null;
}

// Same bps-scaling convention as mcp_server's seriesDelta.ts — HY/IG credit
// spreads are stored as raw percent but reported in bps everywhere else.
const BPS_SERIES = new Set(["BAMLH0A0HYM2", "BAMLC0A0CM"]);

export interface SeriesDelta7d {
  value: number | null;
  delta_7d: number | null;
}

export async function computeSeriesDelta7d(seriesId: string): Promise<SeriesDelta7d> {
  const latest = await getLatestDataPoint(seriesId);
  if (!latest) return { value: null, delta_7d: null };

  const scale = BPS_SERIES.has(seriesId) ? 100 : 1;
  const v7 = await getValueOnOrBefore(seriesId, subtractDays(latest.observation_date, 7));
  const round = (n: number) => Math.round(n * 1000) / 1000;

  return {
    value: round(latest.value * scale),
    delta_7d: v7 !== null ? round((latest.value - v7) * scale) : null,
  };
}
