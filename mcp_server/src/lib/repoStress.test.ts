// Run: npm test (node's built-in test runner via tsx -- no test framework dependency).
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeFundingPressureFlag } from "./repoStress.js";

const obs = (pairs: [string, number][]) => pairs.map(([observation_date, value]) => ({ observation_date, value }));

test("fires on the 3rd consecutive observation above +5bp, not before", () => {
  const two = computeFundingPressureFlag(obs([["2025-10-20", 1], ["2025-10-21", 8], ["2025-10-22", 6]]));
  assert.equal(two.flag, false);
  assert.equal(two.consecutive_days_above, 2);
  assert.equal(two.above_since, "2025-10-21");

  const three = computeFundingPressureFlag(obs([["2025-10-20", 1], ["2025-10-21", 8], ["2025-10-22", 6], ["2025-10-23", 9]]));
  assert.equal(three.flag, true);
  assert.equal(three.consecutive_days_above, 3);
  assert.equal(three.above_since, "2025-10-21");
});

test("exactly +5bp is not above the threshold; input order doesn't matter", () => {
  const r = computeFundingPressureFlag(obs([["2026-11-03", 7], ["2026-11-02", 5], ["2026-11-04", 6], ["2026-10-30", 5]]));
  assert.equal(r.flag, false);
  assert.equal(r.consecutive_days_above, 2);
});

test("not above today: run is 0, above_since null", () => {
  const r = computeFundingPressureFlag(obs([["2026-11-10", 9], ["2026-11-11", 9], ["2026-11-12", 0]]));
  assert.equal(r.flag, false);
  assert.equal(r.consecutive_days_above, 0);
  assert.equal(r.above_since, null);
});

test("too little history is unknown (null), never false", () => {
  const r = computeFundingPressureFlag(obs([["2026-11-12", 20], ["2026-11-13", 20]]));
  assert.equal(r.flag, null);
  assert.equal(r.consecutive_days_above, null);
  assert.equal(r.provisional, true);
});
