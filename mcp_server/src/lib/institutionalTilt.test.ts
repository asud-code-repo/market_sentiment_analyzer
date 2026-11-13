// Run: npm test (node's built-in test runner via tsx -- no test framework dependency).
import { test } from "node:test";
import assert from "node:assert/strict";
import { institutionalTilt, TILT_BAND_PTS } from "./institutionalTilt.js";

test("subtracts the cross-sector average, so a shared move reads as in line", () => {
  // Every sector +8%: institutions bought everything equally, no tilt.
  const tilt = institutionalTilt(new Map([["XLK", 8], ["XLF", 8], ["XLE", 8]]));
  for (const t of tilt.values()) {
    assert.equal(t.vsAvgPts, 0);
    assert.equal(t.read, "in_line");
  }
});

test("labels sectors outside the band as tilting toward / away", () => {
  // avg = 4: XLK +6 vs avg, XLF -3, XLE -3
  const tilt = institutionalTilt(new Map([["XLK", 10], ["XLF", 1], ["XLE", 1]]));
  assert.deepEqual(tilt.get("XLK"), { vsAvgPts: 6, read: "tilting_toward" });
  assert.deepEqual(tilt.get("XLF"), { vsAvgPts: -3, read: "tilting_away" });
});

test("the band edge itself reads as in line", () => {
  const tilt = institutionalTilt(new Map([["A", TILT_BAND_PTS], ["B", -TILT_BAND_PTS]]));
  assert.equal(tilt.get("A")!.read, "in_line");
  assert.equal(tilt.get("B")!.read, "in_line");
});

test("needs at least two sectors to compare", () => {
  assert.equal(institutionalTilt(new Map([["XLK", 5]])).size, 0);
  assert.equal(institutionalTilt(new Map()).size, 0);
});
