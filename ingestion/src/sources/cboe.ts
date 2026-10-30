import type { DataPoint } from "../lib/supabase.js";

// CBOE daily put/call ratios. Replaced 2026-10-29: the previous source
// (cdn.cboe.com/.../totalpc.csv) turned out to be a frozen archive whose
// last row is 2019-10-04, so this source had been failing (best-effort)
// every day since it was added. CBOE's market-statistics page is rendered
// client-side, but it reads a static per-day JSON file from the same CDN --
// verified live 2026-10-29, free, no key, and available from 2019-10-07
// onward (the first trading day after the old archive stops). Non-trading
// days return HTTP 403, not 404.
//
// Three ratios are stored: EQUITY (single-stock options -- the speculative
// / retail-heavy read, the one usually used as a contrarian sentiment
// gauge), INDEX (mostly institutional hedging via SPX etc.), and TOTAL.
const DAILY_URL = (date: string) => `https://cdn.cboe.com/data/us/options/market_statistics/daily/${date}_daily_options`;
const FIRST_AVAILABLE_DATE = "2019-10-07";
const MAX_STALENESS_DAYS = 5;

const RATIOS = [
  { name: "TOTAL PUT/CALL RATIO", seriesId: "CBOE_TOTAL_PC_RATIO" },
  { name: "EQUITY PUT/CALL RATIO", seriesId: "CBOE_EQUITY_PC_RATIO" },
  { name: "INDEX PUT/CALL RATIO", seriesId: "CBOE_INDEX_PC_RATIO" },
] as const;

interface DailyOptionsJson {
  ratios?: { name: string; value: string }[];
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function weekdaysBetween(startIso: string, endIso: string): string[] {
  const dates: string[] = [];
  const d = new Date(`${startIso}T00:00:00Z`);
  const end = new Date(`${endIso}T00:00:00Z`);
  while (d <= end) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) dates.push(isoDate(d));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return dates;
}

/** One trading day's ratios, or [] for a non-trading day (HTTP 403/404). */
async function fetchDay(date: string): Promise<DataPoint[]> {
  const res = await fetch(DAILY_URL(date));
  if (res.status === 403 || res.status === 404) return [];
  if (!res.ok) {
    throw new Error(`CBOE daily options request for ${date} failed: HTTP ${res.status}`);
  }
  const json = (await res.json()) as DailyOptionsJson;
  const points: DataPoint[] = [];
  for (const { name, seriesId } of RATIOS) {
    const raw = json.ratios?.find((r) => r.name === name)?.value;
    const value = Number(raw);
    if (raw === undefined || !Number.isFinite(value) || value <= 0) continue;
    points.push({
      series_id: seriesId,
      source: "CBOE",
      source_series_code: name,
      observation_date: date,
      value,
      unit: "ratio",
    });
  }
  return points;
}

/**
 * Daily run: the trailing week of weekdays (self-heals a missed day). Fails
 * loudly if nothing in the last MAX_STALENESS_DAYS came back, rather than
 * silently writing nothing.
 */
export async function fetchCboe(): Promise<DataPoint[]> {
  const today = new Date();
  // Stops at YESTERDAY: CBOE publishes the current day's file intraday
  // (confirmed 2026-10-29 -- that day's file existed mid-session), and the
  // 10am-ET ingest run would otherwise store a ~30-minute partial reading.
  const end = new Date(today);
  end.setUTCDate(end.getUTCDate() - 1);
  const start = new Date(today);
  start.setUTCDate(start.getUTCDate() - 8);
  const days = await Promise.all(weekdaysBetween(isoDate(start), isoDate(end)).map(fetchDay));
  const points = days.flat();

  const latest = points.map((p) => p.observation_date).sort().at(-1);
  const ageDays = latest ? (today.getTime() - new Date(`${latest}T00:00:00Z`).getTime()) / 86400000 : Infinity;
  if (ageDays > MAX_STALENESS_DAYS) {
    throw new Error(
      `CBOE put/call: no trading-day file within the last ${MAX_STALENESS_DAYS} days (latest: ${latest ?? "none"}) -- endpoint may have moved.`,
    );
  }
  return points;
}

/**
 * Backfill: every weekday since 2019-10-07 (~1,800 requests). Small fixed
 * concurrency to stay polite to CBOE's CDN; holidays just come back empty.
 */
export async function fetchCboeBackfill(): Promise<DataPoint[]> {
  const yesterday = new Date();
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const dates = weekdaysBetween(FIRST_AVAILABLE_DATE, isoDate(yesterday));
  const CONCURRENCY = 6;
  const points: DataPoint[] = [];
  for (let i = 0; i < dates.length; i += CONCURRENCY) {
    const batch = await Promise.all(dates.slice(i, i + CONCURRENCY).map(fetchDay));
    points.push(...batch.flat());
  }
  return points;
}
