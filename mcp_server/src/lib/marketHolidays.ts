// US market holidays with no daily observation in the core FRED series.
//
// Federal Reserve holidays: the Fed's H.15 release (Treasury yields, e.g.
// DGS10) has no value for these days, and most other daily FRED series skip
// them too. Fed observance rules: a holiday falling on a Sunday is observed
// the following Monday; one falling on a Saturday is NOT moved (Reserve
// Banks stay open the Friday before). Good Friday is added on top: not a Fed
// holiday, but the bond market (SIFMA) and the stock market (VIX, S&P 500)
// both close.
//
// Used by freshness.ts so a post-holiday run doesn't flag a healthy feed as
// stale (2026-11-13: after Veterans Day the 10-year's newest reading was
// Nov 10, which the old weekday-only count treated as 3 business days old,
// blocking the scheduled crash check).
//
// Pure, no I/O -- unit-tested in marketHolidays.test.ts.

const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/** The nth (1-based) given weekday (0 = Sunday) of a month; n = -1 means the last one. */
function nthWeekday(year: number, month: number, weekday: number, n: number): string {
  if (n > 0) {
    const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
    return iso(year, month, 1 + ((weekday - first + 7) % 7) + (n - 1) * 7);
  }
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const last = new Date(Date.UTC(year, month - 1, lastDay)).getUTCDay();
  return iso(year, month, lastDay - ((last - weekday + 7) % 7));
}

/** A fixed-date holiday, moved to Monday when it falls on a Sunday (Saturday: not moved, per the Fed). */
function fixed(year: number, month: number, day: number): string {
  const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return dow === 0 ? iso(year, month, day + 1) : iso(year, month, day);
}

/** Gregorian Easter Sunday (anonymous / Meeus algorithm). */
function easter(year: number): Date {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

const cache = new Map<number, Set<string>>();
function holidaysFor(year: number): Set<string> {
  let set = cache.get(year);
  if (!set) {
    const goodFriday = easter(year);
    goodFriday.setUTCDate(goodFriday.getUTCDate() - 2);
    set = new Set([
      fixed(year, 1, 1), // New Year's Day
      nthWeekday(year, 1, 1, 3), // Martin Luther King Jr. Day
      nthWeekday(year, 2, 1, 3), // Presidents' Day
      goodFriday.toISOString().slice(0, 10), // Good Friday (markets, not the Fed)
      nthWeekday(year, 5, 1, -1), // Memorial Day
      fixed(year, 6, 19), // Juneteenth
      fixed(year, 7, 4), // Independence Day
      nthWeekday(year, 9, 1, 1), // Labor Day
      nthWeekday(year, 10, 1, 2), // Columbus Day
      fixed(year, 11, 11), // Veterans Day
      nthWeekday(year, 11, 4, 4), // Thanksgiving
      fixed(year, 12, 25), // Christmas
    ]);
    cache.set(year, set);
  }
  return set;
}

/** Whether a YYYY-MM-DD date is a market holiday (see the header for which ones). */
export function isMarketHoliday(dateStr: string): boolean {
  return holidaysFor(Number(dateStr.slice(0, 4))).has(dateStr);
}

/** Whether a YYYY-MM-DD date is a weekday that isn't a market holiday. */
export function isBusinessDay(dateStr: string): boolean {
  const dow = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
  return dow !== 0 && dow !== 6 && !isMarketHoliday(dateStr);
}

/** The business day strictly before the given YYYY-MM-DD date (skips weekends and market holidays). */
export function previousBusinessDay(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  do {
    d.setUTCDate(d.getUTCDate() - 1);
  } while (!isBusinessDay(d.toISOString().slice(0, 10)));
  return d.toISOString().slice(0, 10);
}
