// Scenario scorecard (2026-11-17): records each tilt-based full report's
// split (written by mcp_server's write_snapshot from the frozen prior in
// config/scenario_prior_v1.json) and, once 63 more S&P closes exist, which
// bucket actually happened. Pure logic here; Supabase I/O in
// scenarioScorecardStore.ts.
//
// Report-only. Nothing reads it to decide anything, and the prior and the
// 5-point step are never retuned from these outcomes (crash-check-rules.md,
// "Crash-Probability Scoring Methodology"). It shows, over years, whether
// "higher" days really saw more falls than "in line" days.

export const SCENARIO_HORIZON = 63;
export type Bucket = "bull" | "base" | "bear" | "crash";

export interface ScenarioOutcome {
  bucket: Bucket;
  /** Deepest close below the as-of close within the window, positive %. */
  worst_fall_pct: number;
  /** Day-63 close vs the as-of close, %. */
  return_pct: number;
}

/**
 * Pure. Buckets as defined in config/scenario_prior_v1.json: crash = a close
 * 20%+ below the as-of close within 63 trading days; bear = 10% to under 20%;
 * bull = no 10% fall and the day-63 close at least 5% higher; base = the
 * rest. Null while fewer than 63 later closes exist.
 */
export function resolveScenarioOutcome(asOfClose: number, closesAfter: number[], horizon = SCENARIO_HORIZON): ScenarioOutcome | null {
  if (closesAfter.length < horizon) return null;
  const window = closesAfter.slice(0, horizon);
  // Rounded to 1e-9 so an exact 20% / 10% / 5% move isn't lost to float error (1 - 80/100 = 0.19999...).
  const clean = (x: number) => Math.round(x * 1e9) / 1e9;
  const worst = clean((1 - Math.min(...window) / asOfClose) * 100);
  const ret = clean((window[horizon - 1] / asOfClose - 1) * 100);
  const bucket: Bucket = worst >= 20 ? "crash" : worst >= 10 ? "bear" : ret >= 5 ? "bull" : "base";
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return { bucket, worst_fall_pct: r2(Math.max(0, worst)), return_pct: r2(ret) };
}
