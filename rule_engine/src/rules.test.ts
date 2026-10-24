import { describe, it, expect } from "vitest";
import {
  bandVix,
  bandHySpreadBps,
  bandSpDrawdownPct,
  bandTreasury10y,
  bandSahmRule,
  bandFedPivotSignal,
  bandVixRecovery,
  countReds,
  isWaveAuthorized,
  activeWave,
  slowBearW2Condition,
  slowBearW3Condition,
  drawdownPct,
  isRecoveredFromTrough,
  computeConfirmation,
  type ConfirmationEntry,
} from "./rules.js";

describe("band functions — boundary values", () => {
  it("bandVix: GREEN < 20, AMBER 20-35, RED > 35", () => {
    expect(bandVix(19.99)).toBe("GREEN");
    expect(bandVix(20)).toBe("AMBER");
    expect(bandVix(35)).toBe("AMBER");
    expect(bandVix(35.01)).toBe("RED");
  });

  it("bandHySpreadBps: GREEN < 350, AMBER 350-500, RED > 500", () => {
    expect(bandHySpreadBps(349.99)).toBe("GREEN");
    expect(bandHySpreadBps(350)).toBe("AMBER");
    expect(bandHySpreadBps(500)).toBe("AMBER");
    expect(bandHySpreadBps(500.01)).toBe("RED");
  });

  it("bandSpDrawdownPct: GREEN < 10, AMBER 10-20, RED > 20", () => {
    expect(bandSpDrawdownPct(9.99)).toBe("GREEN");
    expect(bandSpDrawdownPct(10)).toBe("AMBER");
    expect(bandSpDrawdownPct(20)).toBe("AMBER");
    expect(bandSpDrawdownPct(20.01)).toBe("RED");
  });

  it("bandTreasury10y: GREEN < 4.3, AMBER 4.3-5.0, RED > 5.0", () => {
    expect(bandTreasury10y(4.29)).toBe("GREEN");
    expect(bandTreasury10y(4.3)).toBe("AMBER");
    expect(bandTreasury10y(5.0)).toBe("AMBER");
    expect(bandTreasury10y(5.01)).toBe("RED");
  });

  it("bandSahmRule: GREEN < 0.3, AMBER 0.3-0.5, RED > 0.5", () => {
    expect(bandSahmRule(0.29)).toBe("GREEN");
    expect(bandSahmRule(0.3)).toBe("AMBER");
    expect(bandSahmRule(0.5)).toBe("AMBER");
    expect(bandSahmRule(0.51)).toBe("RED");
  });

  it("bandFedPivotSignal maps NONE/PAUSE/CUT to GREEN/AMBER/RED", () => {
    expect(bandFedPivotSignal("NONE")).toBe("GREEN");
    expect(bandFedPivotSignal("PAUSE")).toBe("AMBER");
    expect(bandFedPivotSignal("CUT")).toBe("RED");
  });

  it("bandVixRecovery: GREEN below 25, RED at/above 25", () => {
    expect(bandVixRecovery(24.99)).toBe("GREEN");
    expect(bandVixRecovery(25)).toBe("RED");
  });
});

describe("countReds / isWaveAuthorized", () => {
  it("counts only RED entries", () => {
    expect(countReds(["RED", "AMBER", "GREEN", "RED", "RED"])).toBe(3);
    expect(countReds(["GREEN", "AMBER"])).toBe(0);
  });

  it("wave authorization requires 3+ reds (boundary)", () => {
    expect(isWaveAuthorized(2)).toBe(false);
    expect(isWaveAuthorized(3)).toBe(true);
    expect(isWaveAuthorized(4)).toBe(true);
  });
});

describe("activeWave — fast-panic drawdown/VIX gate", () => {
  it("returns NONE below every wave's drawdown floor", () => {
    expect(activeWave(15, 50)).toBe("NONE");
  });

  it("requires both drawdown AND vix to clear a wave's bar", () => {
    expect(activeWave(16, 28)).toBe("NONE"); // vix not > 28
    expect(activeWave(16, 28.01)).toBe("WAVE_1");
    expect(activeWave(24, 35)).toBe("WAVE_1"); // fails WAVE_2's vix bar, still satisfies WAVE_1's lower bar
    expect(activeWave(24, 35.01)).toBe("WAVE_2");
    expect(activeWave(35, 45)).toBe("WAVE_2"); // fails WAVE_3's vix bar, still satisfies WAVE_2's lower bar
    expect(activeWave(35, 45.01)).toBe("WAVE_3");
  });

  it("checks highest wave first when a deep drawdown satisfies multiple", () => {
    expect(activeWave(40, 50)).toBe("WAVE_3");
  });
});

describe("slow-bear depth pathway", () => {
  it("requires both depth and a fresh trailing low (<=40 trading days)", () => {
    expect(slowBearW2Condition(24, 40)).toBe(true);
    expect(slowBearW2Condition(24, 41)).toBe(false);
    expect(slowBearW2Condition(23.99, 10)).toBe(false);

    expect(slowBearW3Condition(35, 40)).toBe(true);
    expect(slowBearW3Condition(35, 41)).toBe(false);
    expect(slowBearW3Condition(34.99, 10)).toBe(false);
  });
});

describe("drawdownPct / isRecoveredFromTrough", () => {
  it("computes ATH-relative percentage drawdown", () => {
    expect(drawdownPct(80, 100)).toBe(20);
    expect(drawdownPct(100, 100)).toBe(0);
  });

  it("recovery requires 15%+ above the confirmed trough (boundary)", () => {
    expect(isRecoveredFromTrough(114.99, 100)).toBe(false);
    expect(isRecoveredFromTrough(115, 100)).toBe(true);
  });
});

describe("computeConfirmation — Signal Tiering & Confirmation Windows", () => {
  it("bootstraps a first-ever run as day 1, unconfirmed (default requiredCount 2)", () => {
    const entry = computeConfirmation("RED", "2026-01-01", undefined);
    expect(entry).toEqual<ConfirmationEntry>({
      color: "RED",
      observation_date: "2026-01-01",
      days_confirmed: 1,
      confirmed: false,
      first_breach_date: "2026-01-01",
    });
  });

  it("confirms once days_confirmed reaches requiredCount", () => {
    const day1 = computeConfirmation("RED", "2026-01-01", undefined);
    const day2 = computeConfirmation("RED", "2026-01-02", day1);
    expect(day2.days_confirmed).toBe(2);
    expect(day2.confirmed).toBe(true);
    expect(day2.first_breach_date).toBe("2026-01-01");
  });

  it("resets the streak when the color changes on a new date", () => {
    const day1 = computeConfirmation("RED", "2026-01-01", undefined);
    const day2 = computeConfirmation("RED", "2026-01-02", day1);
    const day3 = computeConfirmation("GREEN", "2026-01-03", day2);
    expect(day3).toEqual<ConfirmationEntry>({
      color: "GREEN",
      observation_date: "2026-01-03",
      days_confirmed: 1,
      confirmed: false,
      first_breach_date: "2026-01-03",
    });
  });

  it("same date + same color carries the prior entry forward unchanged (same-day re-trigger)", () => {
    const day1 = computeConfirmation("RED", "2026-01-01", undefined);
    const retrigger = computeConfirmation("RED", "2026-01-01", day1);
    expect(retrigger).toBe(day1);
  });

  it("same date + revised color restarts the streak at 1 (F07 regression: a same-day revision must not inherit the pre-revision streak)", () => {
    const day1 = computeConfirmation("RED", "2026-01-01", undefined);
    const day2 = computeConfirmation("RED", "2026-01-02", day1);
    const revised = computeConfirmation("GREEN", "2026-01-02", day2);
    expect(revised).toEqual<ConfirmationEntry>({
      color: "GREEN",
      observation_date: "2026-01-02",
      days_confirmed: 1,
      confirmed: false,
      first_breach_date: "2026-01-02",
    });
  });

  it("supports a longer requiredCount window (Stage 4 recovery's 15-observation VIX check)", () => {
    let entry: ConfirmationEntry | undefined;
    for (let day = 1; day <= 15; day++) {
      entry = computeConfirmation("GREEN", `2026-02-${String(day).padStart(2, "0")}`, entry, 15);
    }
    expect(entry!.days_confirmed).toBe(15);
    expect(entry!.confirmed).toBe(true);
  });
});
