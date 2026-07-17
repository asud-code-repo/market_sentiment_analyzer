import { supabase, getLatestDataPoint } from "./supabase.js";

/**
 * 3-day/7-day calendar-day deltas for a data_points series, per
 * crash-check-rules.md's Delta standard ("compute both deltas off calendar
 * days, not check-to-check gaps"). No MCP tool previously exposed
 * historical N-days-ago lookback values — get_indicator_panel/
 * get_watchlist_status only ever returned the latest reading, so this
 * requirement was unfulfillable (verified live: Claude correctly declined
 * to fabricate deltas rather than invent them).
 */
export interface SeriesDeltaResult {
  series_id: string;
  latest_value: number | null;
  latest_date: string | null;
  delta_3d: number | null;
  delta_7d: number | null;
}

function subtractDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * Most recent data_points value on or before the given date — not an exact
 * date match, since markets/FRED don't publish every calendar day
 * (weekends, holidays). This can occasionally return a value less than N
 * days old (e.g. if N-days-ago lands on a Saturday, this finds Friday's
 * value instead) — an accepted approximation, same spirit as this
 * project's other backward-search date patterns.
 */
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

// BAMLH0A0HYM2 is stored in data_points as a raw percent (e.g. 3.2), but
// every other part of this system (classify.ts, get_indicator_panel's
// hy_spread_bps field) reports HY spread in basis points (x100) — matching
// that existing convention here so a delta isn't accidentally reported
// two orders of magnitude off from the value it's a delta of.
const BPS_SERIES = new Set(["BAMLH0A0HYM2"]);

/**
 * Looks up the series' current value fresh (not trusted from caller input)
 * and computes both deltas anchored to that value's own observation_date —
 * not "today," since FRED series routinely lag by a day or more and using
 * today's date as the anchor would silently misalign the 3-day/7-day
 * windows against a value that's actually already a day or two stale.
 */
export async function computeSeriesDelta(seriesId: string): Promise<SeriesDeltaResult> {
  const latest = await getLatestDataPoint(seriesId);
  if (!latest) {
    return { series_id: seriesId, latest_value: null, latest_date: null, delta_3d: null, delta_7d: null };
  }

  const scale = BPS_SERIES.has(seriesId) ? 100 : 1;
  const [v3, v7] = await Promise.all([
    getValueOnOrBefore(seriesId, subtractDays(latest.observation_date, 3)),
    getValueOnOrBefore(seriesId, subtractDays(latest.observation_date, 7)),
  ]);

  const round = (n: number) => Math.round(n * 1000) / 1000;
  return {
    series_id: seriesId,
    latest_value: round(latest.value * scale),
    latest_date: latest.observation_date,
    delta_3d: v3 !== null ? round((latest.value - v3) * scale) : null,
    delta_7d: v7 !== null ? round((latest.value - v7) * scale) : null,
  };
}
