import { describe, it, expect } from "vitest";
import { resolveScenarioOutcome } from "./scenarioScorecard.js";

const flat = (n: number, v: number) => Array.from({ length: n }, () => v);

describe("scenario outcome buckets (63 trading days from the as-of close)", () => {
  it("null until 63 later closes exist", () => {
    expect(resolveScenarioOutcome(100, flat(62, 100))).toBeNull();
  });

  it("crash at a 20% fall, bear at 10-20%, regardless of where it ends", () => {
    expect(resolveScenarioOutcome(100, [...flat(30, 100), 80, ...flat(32, 120)])!.bucket).toBe("crash");
    expect(resolveScenarioOutcome(100, [...flat(30, 100), 80.01, ...flat(32, 120)])!.bucket).toBe("bear");
    expect(resolveScenarioOutcome(100, [...flat(30, 100), 90, ...flat(32, 100)])!.bucket).toBe("bear");
  });

  it("bull needs no 10% fall and a day-63 close 5%+ higher; else base", () => {
    expect(resolveScenarioOutcome(100, [...flat(62, 101), 105])!.bucket).toBe("bull");
    expect(resolveScenarioOutcome(100, [...flat(62, 101), 104.99])!.bucket).toBe("base");
    expect(resolveScenarioOutcome(100, [...flat(30, 90.01), ...flat(33, 106)])!.bucket).toBe("bull");
  });

  it("uses only the first 63 closes and reports worst fall and return", () => {
    const o = resolveScenarioOutcome(100, [...flat(62, 95), 102, 50]);
    expect(o).toEqual({ bucket: "base", worst_fall_pct: 5, return_pct: 2 });
  });
});
