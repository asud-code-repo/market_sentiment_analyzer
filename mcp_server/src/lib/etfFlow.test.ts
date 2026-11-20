// Run: npm test (node's built-in test runner via tsx -- no test framework dependency).
import { test } from "node:test";
import assert from "node:assert/strict";
import { flowUsdBetween } from "./etfFlow.js";

const pts = [
  { date: "2026-01-01", nav: 100, shares: 1000 },
  { date: "2026-01-02", nav: 110, shares: 1010 }, // +10 shares at 110
  { date: "2026-01-03", nav: 200, shares: 1010 }, // price doubles, no flow
  { date: "2026-01-04", nav: 200, shares: 1005 }, // -5 shares at 200
];

test("values each day's share change at that day's NAV", () => {
  assert.equal(flowUsdBetween(pts, "2026-01-01", "2026-01-04"), 10 * 110 - 5 * 200);
});

test("a price move with no share change is no flow (the old end-NAV method gave 5 x 200)", () => {
  assert.equal(flowUsdBetween(pts, "2026-01-02", "2026-01-03"), 0);
});

test("starts from the last point on or before fromDate and stops at toDate", () => {
  assert.equal(flowUsdBetween(pts, "2026-01-01", "2026-01-02"), 10 * 110);
  assert.equal(flowUsdBetween(pts, "2026-01-03", "2026-01-09"), -5 * 200);
  assert.equal(flowUsdBetween(pts, "2025-12-31", "2026-01-04"), null);
});

test("skips a day with missing shares and lets the next valid day cover it", () => {
  const gap = [pts[0], { date: "2026-01-02", nav: 110, shares: NaN }, { date: "2026-01-03", nav: 120, shares: 1010 }];
  assert.equal(flowUsdBetween(gap, "2026-01-01", "2026-01-03"), 10 * 120);
});
