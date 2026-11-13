// Deterministic FOMC-meeting / CPI-release date resolution — fixes a real
// staleness bug: a live chat report was observed still showing "Fed-event
// trigger — July FOMC — FIRED" with nothing that would have advanced it to
// September's meeting. FOMC meeting dates and CPI release dates are publicly
// published, non-judgment-call facts (unlike earnings-guidance, which stays
// entirely LLM-judged — see crash-check-rules.md), so which meeting/release
// is currently relevant is computed here instead of hand-tracked in prose.
//
// This is deliberately NOT a fired/pending binary like the rate-reset
// trigger (mcp_server/src/lib/portfolio.ts) — an FOMC meeting has no
// "waiting period" the way a declared rate does. It answers "which
// meeting/release IS current," never "is it fired." The qualitative read
// (hawkish/dovish, beat/miss) stays 100% LLM-judged, unchanged.
//
// Data sourced and verified directly 2026-08-26:
// - FOMC: https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm
//   (fetched directly; 2027 dates are explicitly marked tentative by the Fed
//   itself, confirmed only at the meeting immediately preceding each one).
// - CPI: https://www.bls.gov/schedule/news_release/cpi.htm blocks automated
//   fetch (403) — verified instead against
//   https://www.usinflationcalculator.com/inflation/consumer-price-index-release-schedule/,
//   a dedicated release-schedule table, after an initial web search snippet
//   surfaced a conflicting date that this direct table fetch resolved as
//   wrong. 2027 CPI dates are not yet published anywhere — BLS has not
//   released them. Do not add placeholder 2027 CPI dates; let
//   calendar_needs_update fire honestly once 2026's known dates run out.
//
// MAINTENANCE: needs new entries roughly annually. The Fed publishes each
// year's full FOMC calendar in advance (out-year dates start tentative);
// BLS typically publishes next year's CPI schedule around October of the
// prior year. Re-verify against the URLs above before extending.

export interface CalendarEvent {
  date: string; // ISO YYYY-MM-DD — the single decision-relevant date
                // (FOMC: the meeting's second/decision day; CPI: release day)
  label: string;
  tentative?: boolean; // true for out-year dates not yet finalized by the Fed
}

export interface EventResolution {
  most_recent_past: CalendarEvent | null;
  next_upcoming: CalendarEvent | null;
  calendar_needs_update: boolean;
  note: string;
}

export interface EconomicEventTrigger {
  current_target_date: string | null;
  current_target_label: string | null;
  next_target_date: string | null;
  next_target_label: string | null;
  calendar_needs_update: boolean;
  note: string;
}

const FOMC_MEETINGS: CalendarEvent[] = [
  { date: "2026-01-28", label: "January 2026 FOMC meeting (Jan 27-28)" },
  { date: "2026-03-18", label: "March 2026 FOMC meeting (Mar 17-18)" },
  { date: "2026-04-29", label: "April 2026 FOMC meeting (Apr 28-29)" },
  { date: "2026-06-17", label: "June 2026 FOMC meeting (Jun 16-17)" },
  { date: "2026-07-29", label: "July 2026 FOMC meeting (Jul 28-29)" },
  { date: "2026-09-16", label: "September 2026 FOMC meeting (Sep 15-16)" },
  { date: "2026-10-28", label: "October 2026 FOMC meeting (Oct 27-28)" },
  { date: "2026-12-09", label: "December 2026 FOMC meeting (Dec 8-9)" },
  { date: "2027-01-27", label: "January 2027 FOMC meeting (Jan 26-27)", tentative: true },
  { date: "2027-03-17", label: "March 2027 FOMC meeting (Mar 16-17)", tentative: true },
  { date: "2027-04-28", label: "April 2027 FOMC meeting (Apr 27-28)", tentative: true },
  { date: "2027-06-09", label: "June 2027 FOMC meeting (Jun 8-9)", tentative: true },
  { date: "2027-07-28", label: "July 2027 FOMC meeting (Jul 27-28)", tentative: true },
  { date: "2027-09-15", label: "September 2027 FOMC meeting (Sep 14-15)", tentative: true },
  { date: "2027-10-27", label: "October 2027 FOMC meeting (Oct 26-27)", tentative: true },
  { date: "2027-12-08", label: "December 2027 FOMC meeting (Dec 7-8)", tentative: true },
];

const CPI_RELEASES: CalendarEvent[] = [
  { date: "2026-01-13", label: "December 2025 CPI release" },
  { date: "2026-02-13", label: "January 2026 CPI release" },
  { date: "2026-03-11", label: "February 2026 CPI release" },
  { date: "2026-04-10", label: "March 2026 CPI release" },
  { date: "2026-05-12", label: "April 2026 CPI release" },
  { date: "2026-06-10", label: "May 2026 CPI release" },
  { date: "2026-07-14", label: "June 2026 CPI release" },
  { date: "2026-08-12", label: "July 2026 CPI release" },
  { date: "2026-09-11", label: "August 2026 CPI release" },
  { date: "2026-10-14", label: "September 2026 CPI release" },
  { date: "2026-11-10", label: "October 2026 CPI release" },
  { date: "2026-12-10", label: "November 2026 CPI release" },
  // 2027 dates not yet published by BLS as of the verification date above —
  // do not add placeholders here.
];

// Treasury Quarterly Refunding announcements (E3, 2026-11-13): the
// Wednesday 8:30am ET Quarterly Refunding Statement (coupon auction sizes,
// buyback scale, forward guidance), preceded on the Monday by the
// marketable-borrowing estimates. Verified 2026-11-13 directly against
// treasury.gov press releases, each statement's last paragraph naming the
// next one: sb0384 (Feb 4), sb0489 (May 6), sb0590 (Aug 5), sb0678 (Nov 4,
// "The next quarterly refunding announcement will take place on Wednesday,
// February 3, 2027"). Index:
// https://home.treasury.gov/policy-issues/financing-the-government/quarterly-refunding/most-recent-quarterly-refunding-documents
//
// MAINTENANCE: Treasury announces only ONE refunding ahead, so after each
// refunding add the next date from that statement's last paragraph. Until
// then calendar_needs_update turns true once the last date here has passed
// -- that roughly quarterly flip is the reminder, by design. Never add a
// date by pattern (e.g. "first Wednesday of the month").
const REFUNDING_ANNOUNCEMENTS: CalendarEvent[] = [
  { date: "2026-02-04", label: "February 2026 Quarterly Refunding (estimates Feb 2, statement Feb 4)" },
  { date: "2026-05-06", label: "May 2026 Quarterly Refunding (estimates May 4, statement May 6)" },
  { date: "2026-08-05", label: "August 2026 Quarterly Refunding (estimates Aug 3, statement Aug 5)" },
  { date: "2026-11-04", label: "November 2026 Quarterly Refunding (estimates Nov 2, statement Nov 4)" },
  { date: "2027-02-03", label: "February 2027 Quarterly Refunding (estimates Feb 1, statement Feb 3)" },
];

/**
 * Pure date-lookup, not a status classification — answers "which meeting/
 * release IS current," never "is it fired/pending." Defensively re-sorts
 * rather than trusting caller order (hand-maintained list). If today is on
 * or past every known date, next_upcoming is null and calendar_needs_update
 * is true — this must fail loudly rather than silently re-reporting a stale
 * entry as current (the exact bug this module fixes).
 */
export function resolveCalendarEvents(
  events: CalendarEvent[],
  today: string = new Date().toISOString().slice(0, 10),
): EventResolution {
  const sorted = [...events].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  let mostRecentPast: CalendarEvent | null = null;
  let nextUpcoming: CalendarEvent | null = null;

  for (const ev of sorted) {
    if (ev.date <= today) {
      mostRecentPast = ev; // last one <= today wins
    } else if (!nextUpcoming) {
      nextUpcoming = ev; // first strictly-after-today entry
    }
  }

  const lastKnownDate = sorted.length > 0 ? sorted[sorted.length - 1].date : null;
  const calendarNeedsUpdate = lastKnownDate !== null && today > lastKnownDate;

  return {
    most_recent_past: mostRecentPast,
    next_upcoming: nextUpcoming,
    calendar_needs_update: calendarNeedsUpdate,
    note: calendarNeedsUpdate
      ? `Today (${today}) is past the last known date in this calendar (${lastKnownDate}) — ` +
        `economicCalendar.ts needs new dates added before this trigger can be trusted.`
      : mostRecentPast
        ? `Most recent: ${mostRecentPast.label} (${mostRecentPast.date}). Next: ` +
          `${nextUpcoming ? `${nextUpcoming.label} (${nextUpcoming.date})` : "none scheduled yet"}.`
        : `No past occurrence yet in the known calendar. Next: ${nextUpcoming ? `${nextUpcoming.label} (${nextUpcoming.date})` : "unknown"}.`,
  };
}

function toTriggerShape(res: EventResolution): EconomicEventTrigger {
  const tentativeCaveat =
    res.most_recent_past?.tentative || res.next_upcoming?.tentative
      ? " Note: one or more of these dates falls in a not-yet-finalized schedule year — re-verify closer to the date."
      : "";
  return {
    current_target_date: res.most_recent_past?.date ?? null,
    current_target_label: res.most_recent_past?.label ?? null,
    next_target_date: res.next_upcoming?.date ?? null,
    next_target_label: res.next_upcoming?.label ?? null,
    calendar_needs_update: res.calendar_needs_update,
    note: res.note + tentativeCaveat,
  };
}

export function computeFedEventTrigger(today?: string): EconomicEventTrigger {
  return toTriggerShape(resolveCalendarEvents(FOMC_MEETINGS, today));
}

export function computeInflationPrintTrigger(today?: string): EconomicEventTrigger {
  return toTriggerShape(resolveCalendarEvents(CPI_RELEASES, today));
}

export function computeFiscalEventTrigger(today?: string): EconomicEventTrigger {
  return toTriggerShape(resolveCalendarEvents(REFUNDING_ANNOUNCEMENTS, today));
}

/** Calendar for a trigger_status entry, matched by canonical name prefix; null for non-calendar triggers. */
function calendarForTriggerName(lowerName: string): CalendarEvent[] | null {
  if (lowerName.startsWith("fed-event")) return FOMC_MEETINGS;
  if (lowerName.startsWith("inflation-print")) return CPI_RELEASES;
  if (lowerName.startsWith("fiscal-event")) return REFUNDING_ANNOUNCEMENTS;
  return null;
}

/**
 * Attaches the next scheduled meeting/release to each fed-event /
 * inflation-print trigger entry whose own date has passed, so the public
 * dashboard can lead with the upcoming event the way the chat report does
 * (added 2026-11-11). Stored entries record the LAST event and its assessed
 * outcome; the dashboard has no calendar of its own. Pure date lookup from
 * the same calendar above -- "next after this entry's date," not "next after
 * today," so a stale entry can't be paired with the wrong follow-on event.
 * Other entries pass through untouched. Overwrites any caller-supplied
 * next_date/next_label (mechanical, never trusted from the caller).
 */
export function attachNextScheduledEvents(entries: unknown[], today: string = new Date().toISOString().slice(0, 10)): unknown[] {
  return entries.map((raw) => {
    const entry = raw as Record<string, unknown>;
    const name = typeof entry.name === "string" ? entry.name.toLowerCase() : "";
    const date = typeof entry.date === "string" ? entry.date : null;
    const calendar = calendarForTriggerName(name);
    if (!calendar || !date || date > today) return raw;
    const { next_date: _d, next_label: _l, ...rest } = entry;
    const next = resolveCalendarEvents(calendar, date).next_upcoming;
    return next ? { ...rest, next_date: next.date, next_label: next.label } : rest;
  });
}
