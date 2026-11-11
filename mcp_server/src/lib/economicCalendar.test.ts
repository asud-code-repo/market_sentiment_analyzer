// Run: npm test (node's built-in test runner via tsx).
import { test } from "node:test";
import assert from "node:assert/strict";
import { attachNextScheduledEvents } from "./economicCalendar.js";

const TODAY = "2026-11-11";

test("fired fed-event and inflation-print entries get the next scheduled event", () => {
  const out = attachNextScheduledEvents([
    { name: "Fed-event trigger (October 2026 FOMC meeting (Oct 27-28))", date: "2026-10-28", status: "fired", note: "x" },
    { name: "Inflation-print trigger (October 2026 CPI release)", date: "2026-11-10", status: "fired" },
  ], TODAY) as Record<string, unknown>[];
  assert.equal(out[0].next_date, "2026-12-09");
  assert.equal(out[0].next_label, "December 2026 FOMC meeting (Dec 8-9)");
  assert.equal(out[0].note, "x");
  assert.equal(out[1].next_date, "2026-12-10");
});

test("next is relative to the entry's own date, not today", () => {
  const [e] = attachNextScheduledEvents([
    { name: "Fed-event trigger (September 2026 FOMC meeting (Sep 15-16))", date: "2026-09-16", status: "fired" },
  ], TODAY) as Record<string, unknown>[];
  assert.equal(e.next_date, "2026-10-28");
});

test("future-dated, other trigger types, and caller-supplied values", () => {
  const future = { name: "Fed-event trigger (December 2026 FOMC meeting (Dec 8-9))", date: "2026-12-09", status: "approaching" };
  const earnings = { name: "Earnings-guidance trigger (Q4 2026 earnings season)", date: "2027-01-14", status: "pending" };
  const [a, b] = attachNextScheduledEvents([future, earnings], TODAY);
  assert.equal(a, future);
  assert.equal(b, earnings);
  const [c] = attachNextScheduledEvents([
    { name: "Inflation-print trigger (November 2026 CPI release)", date: "2026-12-10", status: "fired", next_date: "bogus", next_label: "bogus" },
  ], "2026-12-11") as Record<string, unknown>[];
  // No 2027 CPI dates published yet: no next, and the bogus caller values are dropped.
  assert.equal(c.next_date, undefined);
  assert.equal(c.next_label, undefined);
});
