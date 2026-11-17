// Drawdown + VIX risk band, and the live scorecard that records it next to
// the retired logistic hazard model.
//
// The band (baselineScore + bandBaseline) is what the dashboard and MCP show
// since 2026-11-17: in out-of-sample tests the logistic model and three
// rebuilt variants all failed to beat it
// (reference_docs/hazard-model-rebuild-brief.md). The model is still scored
// each day purely so the scorecard keeps an honest side-by-side record.
//
// Scorecard: each day the question applies records both bands, then, once 21
// (and 63) more S&P closes exist, whether the S&P actually touched a >=10%
// drawdown from its all-time high in that window.
//
// Nothing here feeds the stress gate, wave evaluation or any other decision.
// Public inputs only (S&P, VIX, model outputs), so the table is anon-readable
// like crash_checks.

import type { HazardBand } from "./hazardModel.js";

export const MODEL_VERSION = "frozen-2026-08-26";
export const BASELINE_VERSION = "dd_plus_vix_over_5_v1";
export const HORIZONS = [21, 63] as const;
export const BREACH_PCT = 10;

/**
 * Baseline score: drawdown % (positive) + VIX / 5. The same score the
 * 2026-11-09 replay used as its drawdown + VIX comparison (AUC 0.834).
 */
export function baselineScore(drawdownPct: number, vix: number): number {
  return drawdownPct + vix / 5;
}

/**
 * Cutoffs fixed 2026-11-16, before any live scoring, so the baseline flags
 * about the same share of days as the model's bands did in the 1994-2026
 * replay (HIGH ~15%, TRANSITIONING ~8%). Replay hit rates: 4.6 / 16.8 /
 * 44.4% (model: 3.3 / 16.3 / 53.7%). Drawdown 5% with VIX 25 is exactly
 * HIGH, matching the replay's "dd >= 5 & VIX >= 25" alert rule. Do not
 * retune these after seeing live outcomes.
 */
export function bandBaseline(score: number): HazardBand {
  if (score >= 10) return "HIGH";
  if (score >= 8.5) return "TRANSITIONING";
  return "LOW";
}

export interface Outcome {
  hit: boolean;
  /** Deepest drawdown from the running all-time high within the window, positive %. */
  max_drawdown_pct: number;
}

/**
 * Pure. Given the all-time high on the as-of date and the S&P closes on the
 * trading days AFTER it (ascending), decide whether a >=10% drawdown from
 * the running high occurred within `horizon` trading days. Null while fewer
 * than `horizon` closes exist (outcome not known yet).
 */
export function resolveOutcome(athAtAsOf: number, closesAfter: number[], horizon: number): Outcome | null {
  if (closesAfter.length < horizon) return null;
  let ath = athAtAsOf;
  let maxDd = 0;
  for (const close of closesAfter.slice(0, horizon)) {
    ath = Math.max(ath, close);
    maxDd = Math.max(maxDd, ((ath - close) / ath) * 100);
  }
  return { hit: maxDd >= BREACH_PCT, max_drawdown_pct: Math.round(maxDd * 100) / 100 };
}
