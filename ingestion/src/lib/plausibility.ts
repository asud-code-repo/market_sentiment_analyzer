import type { DataPoint } from "./supabase.js";

/**
 * Data-noise guard for Tier 1 series (crash-check-rules.md's Signal
 * Tiering — the ones allowed to gate wave authorization or a confirmed
 * RED). The Signal Tiering confirmation rule protects against *market*
 * noise (a single volatile day can't authorize a wave on its own — it must
 * hold across 2+ distinct ingestion dates), but it does nothing about
 * *data* noise: a bad print sitting in data_points for 2+ ingestion dates
 * confirms itself just as validly as a real move would (flagged by
 * external methodology review 2026-07-16).
 *
 * Deliberately NOT a statistical/rolling-sigma check: this system exists
 * specifically to detect genuine extreme moves (a VIX spike to 80+ IS the
 * signal, not noise), so a sigma-based outlier filter risks rejecting
 * exactly the data point the whole system is built to catch — especially
 * right at a crisis's onset, when a calm rolling window would flag the
 * first real spike as "anomalous." Bounds below are hard, generous,
 * physically/historically-grounded sanity checks (comfortably outside any
 * real historical extreme) that only catch genuinely impossible or
 * corrupted values — a decimal-place error, a unit mixup, a duplicate/
 * garbled API response — never a real crisis reading.
 */

interface AbsoluteBoundRule {
  kind: "absolute";
  min: number;
  max: number;
}

interface DayOverDayPctRule {
  // For series whose *level* grows unboundedly over time (an equity index),
  // an absolute range doesn't make sense — bound the day-over-day percent
  // change instead. maxAbsPct is set well beyond any real single-day move
  // in market history (worst on record: Black Monday 1987, -20.5%).
  kind: "day_over_day_pct";
  maxAbsPct: number;
}

type PlausibilityRule = AbsoluteBoundRule | DayOverDayPctRule;

const PLAUSIBILITY_RULES: Record<string, PlausibilityRule> = {
  // VIX: historical range ~9-89 (2008 close high ~80.9, 2020 close high
  // ~82.7); intraday spikes go higher but daily closes stay well under 150.
  VIXCLS: { kind: "absolute", min: 5, max: 150 },
  // HY OAS, raw percent (not yet converted to bps) — 2008 peaked ~19-20%.
  BAMLH0A0HYM2: { kind: "absolute", min: 0, max: 30 },
  // IG OAS, raw percent — structurally much lower than HY; still generous.
  BAMLC0A0CM: { kind: "absolute", min: 0, max: 20 },
  // Treasury yields: 1981's Volcker-era peak was ~15.8% on the 10yr.
  DGS10: { kind: "absolute", min: 0, max: 20 },
  DGS2: { kind: "absolute", min: 0, max: 20 },
  DGS30: { kind: "absolute", min: 0, max: 20 },
  // Sahm Rule: typically 0-1, real recessions have pushed it toward 2-3.
  SAHMREALTIME: { kind: "absolute", min: -1, max: 10 },
  UNRATE: { kind: "absolute", min: 0, max: 30 },
  SP500: { kind: "day_over_day_pct", maxAbsPct: 25 },
};

export interface PlausibilityResult {
  ok: boolean;
  reason?: string;
}

/**
 * previousValue is only needed for day_over_day_pct rules — pass the most
 * recent known data_points value for that series, or undefined/null if
 * there isn't one yet (first-ever ingestion for that series always passes,
 * nothing to compare against).
 */
export function checkPlausibility(point: DataPoint, previousValue: number | null | undefined): PlausibilityResult {
  const rule = PLAUSIBILITY_RULES[point.series_id];
  if (!rule) return { ok: true }; // no rule defined = not a series this guard covers

  if (rule.kind === "absolute") {
    if (point.value < rule.min || point.value > rule.max) {
      return {
        ok: false,
        reason: `${point.series_id}=${point.value} is outside the plausible range [${rule.min}, ${rule.max}]`,
      };
    }
    return { ok: true };
  }

  // day_over_day_pct
  if (previousValue === null || previousValue === undefined || previousValue === 0) {
    return { ok: true }; // nothing to compare against
  }
  const pctChange = ((point.value - previousValue) / Math.abs(previousValue)) * 100;
  if (Math.abs(pctChange) > rule.maxAbsPct) {
    return {
      ok: false,
      reason: `${point.series_id} moved ${pctChange.toFixed(1)}% day-over-day (${previousValue} -> ${point.value}), exceeding the ${rule.maxAbsPct}% plausibility bound`,
    };
  }
  return { ok: true };
}
