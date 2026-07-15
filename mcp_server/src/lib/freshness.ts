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
}

export function computeDataFreshness(latestRunAt: string, now: Date = new Date()): DataFreshness {
  const latestRunDate = easternDateString(new Date(latestRunAt));
  const expectedDate = mostRecentWeekday(easternDateString(now));
  const isFresh = latestRunDate >= expectedDate;
  return {
    is_fresh: isFresh,
    latest_run_date: latestRunDate,
    expected_date: expectedDate,
    note: isFresh
      ? "Latest data matches the expected ingestion date."
      : `Latest crash_checks row is from ${latestRunDate}, but ingestion was expected by ${expectedDate} — ` +
        `the daily GitHub Action may not have run yet today or may have failed. Do not treat the indicator ` +
        `panel as today's data; flag this to the user instead of proceeding with analysis.`,
  };
}
