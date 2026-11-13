// Run: npm test (node's built-in test runner via tsx -- no test framework dependency).
import { test } from "node:test";
import assert from "node:assert/strict";
import { isMarketHoliday, isBusinessDay, previousBusinessDay } from "./marketHolidays.js";
import { computeDataFreshness } from "./freshness.js";

test("Fed holidays + Good Friday, with Sunday -> Monday observance", () => {
  for (const d of [
    "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03" /* not observed: Fed doesn't move Saturday holidays */,
    "2026-09-07", "2026-10-12", "2026-11-11", "2026-11-26", "2026-12-25",
    "2027-07-05" /* Jul 4 2027 is a Sunday */, "2027-03-26" /* Good Friday 2027 */, "2028-04-14" /* Good Friday 2028 */,
  ]) {
    assert.equal(isMarketHoliday(d), d !== "2026-07-03", d);
  }
  assert.equal(isMarketHoliday("2026-11-12"), false);
  assert.equal(isMarketHoliday("2026-11-27"), false); // day after Thanksgiving: markets open
});

test("business-day stepping skips weekends and holidays", () => {
  assert.equal(previousBusinessDay("2026-11-12"), "2026-11-10"); // skips Veterans Day
  assert.equal(previousBusinessDay("2026-11-16"), "2026-11-13"); // Monday -> Friday
  assert.equal(previousBusinessDay("2026-11-30"), "2026-11-27"); // day after Thanksgiving is a business day
  assert.equal(previousBusinessDay("2026-11-27"), "2026-11-25"); // skips Thanksgiving
  assert.equal(isBusinessDay("2026-11-14"), false); // Saturday
});

const daily = (series_id: string, observation_date: string) => ({ series_id, cadence: "daily" as const, observation_date });
const at = (isoUtc: string) => new Date(isoUtc);

test("the Friday after Veterans Day: the 10-year's Nov 10 reading is current", () => {
  // 2026-11-13 2pm ET scheduled run, after that morning's ingestion.
  const f = computeDataFreshness("2026-11-13T15:13:00Z", [daily("DGS10", "2026-11-10"), daily("VIXCLS", "2026-11-12")], at("2026-11-13T19:00:00Z"));
  assert.equal(f.is_fresh, true, f.note);
  // One more business day missing is still a real gap.
  const g = computeDataFreshness("2026-11-13T15:13:00Z", [daily("DGS10", "2026-11-09")], at("2026-11-13T19:00:00Z"));
  assert.equal(g.is_fresh, false);
  assert.deepEqual(g.stale_series.map((s) => s.series_id), ["DGS10"]);
});

test("a normal week is unchanged: two business days back is the limit", () => {
  const now = at("2026-11-19T19:00:00Z"); // Thursday
  assert.equal(computeDataFreshness("2026-11-19T15:10:00Z", [daily("DGS10", "2026-11-17")], now).is_fresh, true);
  assert.equal(computeDataFreshness("2026-11-19T15:10:00Z", [daily("DGS10", "2026-11-16")], now).is_fresh, false);
});

test("the Monday after Thanksgiving allows Wednesday's reading", () => {
  const now = at("2026-11-30T19:00:00Z");
  assert.equal(computeDataFreshness("2026-11-30T15:10:00Z", [daily("DGS10", "2026-11-25")], now).is_fresh, true);
  assert.equal(computeDataFreshness("2026-11-30T15:10:00Z", [daily("DGS10", "2026-11-24")], now).is_fresh, false);
});

test("a run before that day's ingestion still stops (the 4am case)", () => {
  // 2026-11-13 4:15am ET: latest crash_checks row is Thursday's.
  const f = computeDataFreshness("2026-11-12T15:13:00Z", [daily("DGS10", "2026-11-09")], at("2026-11-13T09:15:00Z"));
  assert.equal(f.is_fresh, false);
  assert.match(f.note, /may not have run yet today/);
});
