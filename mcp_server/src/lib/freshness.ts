/**
 * Whether the latest crash_checks row is actually from the expected
 * ingestion date, rather than a stale prior-day row silently being treated
 * as current. Exists because ingest.yml's GitHub Actions cron trigger has
 * observed real delays up to ~60 minutes past its nominal 7am ET schedule —
 * a fixed-offset scheduled Claude run (e.g. "30 minutes after ingestion")
 * isn't a safe assumption, and get_indicator_panel had no way to detect
 * "ingestion hasn't actually run yet today" before this.
 *
 * Dates are computed in America/New_York specifically (not the host
 * machine's local zone) since ingest.yml's schedule is deliberately pinned
 * to US Eastern regardless of where this MCP server happens to run.
 */

function easternDateString(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/**
 * Given a YYYY-MM-DD calendar date, returns that same date if it's a
 * weekday, or the prior Friday if it's a Saturday/Sunday — matching
 * ingest.yml's Mon-Fri-only cron, so a weekend check correctly expects
 * Friday's data rather than flagging a nonexistent weekend run as missing.
 */
function mostRecentWeekday(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const dayOfWeek = d.getUTCDay(); // 0 = Sunday, 6 = Saturday
  const daysBack = dayOfWeek === 0 ? 2 : dayOfWeek === 6 ? 1 : 0;
  d.setUTCDate(d.getUTCDate() - daysBack);
  return d.toISOString().slice(0, 10);
}

export interface DataFreshness {
  is_fresh: boolean;
  latest_run_date: string;
  expected_date: string;
  note: string;
  stale_series: SeriesFreshness[];
}

export interface SeriesFreshness {
  series_id: string;
  observation_date: string;
  cadence: "daily" | "monthly";
  is_fresh: boolean;
}

const daysBetween = (fromDateStr: string, toDateStr: string): number => {
  const from = new Date(`${fromDateStr}T00:00:00Z`).getTime();
  const to = new Date(`${toDateStr}T00:00:00Z`).getTime();
  return Math.round((to - from) / 86_400_000);
};

/** The weekday strictly before the given YYYY-MM-DD date (Monday -> prior Friday). */
function previousWeekday(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  do {
    d.setUTCDate(d.getUTCDate() - 1);
  } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d.toISOString().slice(0, 10);
}

/**
 * A daily-cadence series (VIX, HY spread, S&P, 10Y) is stale if its
 * observation predates the previous weekday. FRED publishes these with a
 * one-business-day lag (today's VIX/HY/10Y close appears the next morning),
 * so requiring today's date meant the 2pm ET scheduled run could never pass
 * this check on any weekday (found 2026-09-23, the run aborted "stale" with
 * a healthy ingest). One business day of lag is the source's normal
 * behavior; two is a genuinely missed update. Holidays aren't modeled, so a
 * post-holiday day may still flag conservatively. A monthly series
 * (Sahm Rule, sourced from BLS employment data) is dated to the 1st of the
 * observed month and released alongside the following month's BLS jobs
 * report (~first Friday of month M+2) — e.g. the August reading
 * (2026-08-01) isn't superseded until early October, a ~62-day gap between
 * releases even when nothing is actually stale. A same daily-age bar would
 * incorrectly flag every monthly series as stale for most of each month, so
 * it gets a wider allowance that comfortably covers that real release
 * cadence without treating a genuinely months-stale reading (a broken feed)
 * as current.
 */
function isSeriesFresh(cadence: "daily" | "monthly", observationDate: string, now: Date): boolean {
  if (cadence === "daily") {
    return observationDate >= previousWeekday(mostRecentWeekday(easternDateString(now)));
  }
  return daysBetween(observationDate, easternDateString(now)) <= 62;
}

/**
 * Whether the underlying core observations behind a crash_checks row are
 * actually current — not just whether the row itself has a fresh run_at.
 * Previously this function only compared the report's own timestamp to
 * today (below), which meant a report generated today could still be
 * built on quarantined/stale source data and still read as "fresh"
 * (external review 2026-09-19, F06) — write_snapshot copies mechanical
 * fields forward from the latest rule-engine row into a new timestamped
 * row, so a fresh generation time never proved the copied values were
 * current. coreSeries should be each of the 6 core indicators' latest
 * data_points row (VIX/HY/SP500/10Y/Sahm — Fed pivot has no numeric series
 * behind it, see rules.ts).
 */
export function computeDataFreshness(
  latestRunAt: string,
  coreSeries: { series_id: string; cadence: "daily" | "monthly"; observation_date: string }[] = [],
  now: Date = new Date(),
): DataFreshness {
  const latestRunDate = easternDateString(new Date(latestRunAt));
  const expectedDate = mostRecentWeekday(easternDateString(now));
  const reportIsFresh = latestRunDate >= expectedDate;

  const seriesFreshness: SeriesFreshness[] = coreSeries.map((s) => ({
    series_id: s.series_id,
    observation_date: s.observation_date,
    cadence: s.cadence,
    is_fresh: isSeriesFresh(s.cadence, s.observation_date, now),
  }));
  const staleSeries = seriesFreshness.filter((s) => !s.is_fresh);
  const isFresh = reportIsFresh && staleSeries.length === 0;

  const notes: string[] = [];
  if (!reportIsFresh) {
    notes.push(
      `Latest crash_checks row is from ${latestRunDate}, but ingestion was expected by ${expectedDate} — ` +
        `the daily GitHub Action may not have run yet today or may have failed.`,
    );
  }
  if (staleSeries.length > 0) {
    notes.push(
      `Stale source data despite the report timestamp: ${staleSeries
        .map((s) => `${s.series_id} (observed ${s.observation_date})`)
        .join(", ")}. A fresh generation time does not mean the underlying values are current.`,
    );
  }

  return {
    is_fresh: isFresh,
    latest_run_date: latestRunDate,
    expected_date: expectedDate,
    note: isFresh
      ? "Latest data matches the expected ingestion date and all core series are current."
      : `${notes.join(" ")} Do not treat the indicator panel as today's data; flag this to the user instead of proceeding with analysis.`,
    stale_series: staleSeries,
  };
}
