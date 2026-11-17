import { describe, it, expect } from "vitest";
import { baselineScore, bandBaseline, resolveOutcome } from "./hazardScorecard.js";

describe("baseline band (drawdown % + VIX/5, cutoffs 8.5 / 10)", () => {
  it("drawdown 5% with VIX 25 is exactly HIGH", () => {
    expect(baselineScore(5, 25)).toBe(10);
    expect(bandBaseline(baselineScore(5, 25))).toBe("HIGH");
  });

  it("boundaries", () => {
    expect(bandBaseline(8.49)).toBe("LOW");
    expect(bandBaseline(8.5)).toBe("TRANSITIONING");
    expect(bandBaseline(9.99)).toBe("TRANSITIONING");
    expect(bandBaseline(10)).toBe("HIGH");
  });

  it("calm market near the high is LOW", () => {
    expect(bandBaseline(baselineScore(1, 15))).toBe("LOW");
  });
});

describe("resolveOutcome", () => {
  it("is unresolved until the full window of closes exists", () => {
    expect(resolveOutcome(100, [99, 98], 3)).toBeNull();
  });

  it("hits when a close is 10% below the as-of all-time high", () => {
    expect(resolveOutcome(100, [97, 90, 95], 3)).toEqual({ hit: true, max_drawdown_pct: 10 });
  });

  it("measures from the running high, not the as-of high", () => {
    // New high at 110, then 99 is exactly 10% below it.
    expect(resolveOutcome(100, [110, 99], 2)).toEqual({ hit: true, max_drawdown_pct: 10 });
  });

  it("ignores closes beyond the horizon", () => {
    expect(resolveOutcome(100, [95, 96, 80], 2)).toEqual({ hit: false, max_drawdown_pct: 5 });
  });

  it("no drawdown at all", () => {
    expect(resolveOutcome(100, [101, 102], 2)).toEqual({ hit: false, max_drawdown_pct: 0 });
  });
});
