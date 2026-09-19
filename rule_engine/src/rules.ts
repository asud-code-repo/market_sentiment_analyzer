// Mirrors reference_docs/rules/crash-check-rules.md — the 6-indicator bands
// and wave-authorization thresholds. If you edit the rules doc, mirror the
// change here. This file intentionally contains no LLM/qualitative logic:
// every function here is a pure, deterministic mapping from numbers to bands.

export type Color = "GREEN" | "AMBER" | "RED";

export function bandVix(value: number): Color {
  if (value < 20) return "GREEN";
  if (value <= 35) return "AMBER";
  return "RED";
}

/** Expects bps (e.g. 290, not 2.90) — convert FRED's percent reading before calling. */
export function bandHySpreadBps(bps: number): Color {
  if (bps < 350) return "GREEN";
  if (bps <= 500) return "AMBER";
  return "RED";
}

export function bandSpDrawdownPct(drawdownPct: number): Color {
  if (drawdownPct < 10) return "GREEN";
  if (drawdownPct <= 20) return "AMBER";
  return "RED";
}

export function bandTreasury10y(pct: number): Color {
  if (pct < 4.3) return "GREEN";
  if (pct <= 5.0) return "AMBER";
  return "RED";
}

export function bandSahmRule(value: number): Color {
  if (value < 0.3) return "GREEN";
  if (value <= 0.5) return "AMBER";
  return "RED";
}

export function bandFedPivotSignal(signal: "NONE" | "PAUSE" | "CUT"): Color {
  if (signal === "NONE") return "GREEN";
  if (signal === "PAUSE") return "AMBER";
  return "RED";
}

export function countReds(colors: Color[]): number {
  return colors.filter((c) => c === "RED").length;
}

/** Wave deployment is authorized when 3+ of the 6 indicators are RED. */
export function isWaveAuthorized(redCount: number): boolean {
  return redCount >= 3;
}

export type WaveActive = "NONE" | "WAVE_1" | "WAVE_2" | "WAVE_3";

/**
 * S&P drawdown / VIX wave triggers — separate gate from the RED-count
 * authorization above. Drawdown thresholds are ATH-relative percentages
 * (the low end of each wave's documented drawdown range in crash-check-
 * rules.md "Wave Deployment Thresholds"), not fixed nominal S&P index
 * levels — a fixed level like "S&P <= 6200" decays as the index's nominal
 * level rises over time, while a drawdown percentage stays meaningful
 * regardless of when it's evaluated. VIX thresholds stay absolute since VIX
 * is already a normalized measure, not subject to the same decay. Per the
 * build spec's own non-goal, the rule engine executes these faithfully and
 * never proposes/auto-updates them. Checked highest-wave-first since a deep
 * drawdown satisfies the lower waves' conditions too.
 */
export function activeWave(drawdownPct: number, vix: number): WaveActive {
  if (drawdownPct >= 35 && vix > 45) return "WAVE_3";
  if (drawdownPct >= 24 && vix > 35) return "WAVE_2";
  if (drawdownPct >= 16 && vix > 28) return "WAVE_1";
  return "NONE";
}

// Slow-bear depth pathway (added 2026-09-19) — a second, independent way to
// reach Wave 2/3 that doesn't require a VIX spike, for crises where price
// damage is severe but volatility never sustains at panic levels. Backtest
// against 33 years / 8,467 trading days of real SPY+VIX+FRED history
// (external Phase 0 Wave Backtest, then a follow-up design/validation pass)
// found the pathway above alone never confirms Wave 3 for dot-com (VIX only
// touched 45 for a single day despite a -49.1% drawdown, the single worst
// in the dataset) and never confirms Wave 2 for 2022 (VIX's peak and the
// deepest drawdown never coincided in that "grinding," low-volatility bear).
//
// The naive fix — depth + persistence, dropping VIX entirely — fails badly:
// SPY didn't reclaim its Oct-2007 high until 2013, so "still below the
// all-time high" stayed true for *years* after the GFC actually bottomed
// and markets calmed down. A depth-only check with no freshness filter
// fired constantly through the calm 2010-2011 recovery period, which would
// have broken the fast-panic pathway's own zero-false-alarm record.
// daysSinceTrailingLow (a fresh ~1-year/252-trading-day S&P low, tracked in
// classify.ts via seriesDelta.ts's isTrailingLow()) fixes this by requiring
// the decline to be ACTIVELY FRESH, not merely "still below a stale peak".
//
// Validated result at this threshold (40 trading days): 5/5 Wave-3 events
// across all 33 years land inside dot-com/GFC, zero false positives; 13
// Wave-2 events, 10 inside the 5 labeled episodes (including 2022) and the
// remaining 3 are real, separately-identifiable stress episodes (the 2011
// debt-ceiling crisis/US downgrade, and COVID's own immediate volatile
// tail one week past its trough) — not genuinely ordinary days, matching
// the same "near-miss is a real crisis, not a false alarm" standard the
// original backtest already established for 1998 LTCM/April 2025.
//
// Caller confirms the boolean result over 2+ distinct observation dates via
// computeConfirmation before treating it as active — same as every other
// confirmed indicator in this system — not evaluated raw/same-day like the
// pathway above.
const SLOW_BEAR_FRESHNESS_WINDOW_TRADING_DAYS = 40;

export function slowBearW2Condition(drawdownPct: number, daysSinceTrailingLow: number): boolean {
  return drawdownPct >= 24 && daysSinceTrailingLow <= SLOW_BEAR_FRESHNESS_WINDOW_TRADING_DAYS;
}

export function slowBearW3Condition(drawdownPct: number, daysSinceTrailingLow: number): boolean {
  return drawdownPct >= 35 && daysSinceTrailingLow <= SLOW_BEAR_FRESHNESS_WINDOW_TRADING_DAYS;
}

export function drawdownPct(level: number, ath: number): number {
  return ((ath - level) / ath) * 100;
}

/**
 * Stage 4 recovery criterion 3's binary flag — VIX sustained below 25 (not
 * the 6-indicator panel's own <20/20-35/>35 bandVix bands, a different
 * threshold for a different purpose). Reuses the Color type as a two-state
 * flag (GREEN = below 25, RED = at/above) rather than inventing a new type,
 * so it can go straight into computeConfirmation with requiredCount: 15.
 */
export function bandVixRecovery(vix: number): Color {
  return vix < 25 ? "GREEN" : "RED";
}

/** Stage 4 recovery criterion 1 — 15%+ recovered from the confirmed trough. */
export function isRecoveredFromTrough(level: number, trough: number): boolean {
  return level >= trough * 1.15;
}

/**
 * Signal Tiering & Confirmation Windows (crash-check-rules.md v5): a
 * Tier-1 indicator's color must hold across 2+ *distinct* ingestion dates
 * before it's "confirmed" — not just be true on whatever row a dashboard
 * happens to render. Distinctness is judged per-indicator by its own
 * observation_date advancing, not by classify.ts's run_at, since indicators
 * update at different cadences (VIX daily, Sahm Rule monthly) and the same
 * calendar day can get classified more than once (manual re-triggers).
 */
export interface ConfirmationEntry {
  color: Color;
  observation_date: string;
  days_confirmed: number;
  confirmed: boolean;
  first_breach_date: string;
}

/**
 * requiredCount defaults to 2 (the standard Signal Tiering bar for the 6
 * core indicators). Generalized 2026-08-16 to support longer windows — e.g.
 * Stage 4 recovery's "VIX sustained below 25 for 3+ consecutive weeks"
 * reuses this exact mechanism with requiredCount: 15 (treating GREEN/RED as
 * a below-25/at-or-above-25 binary flag, skipping AMBER) rather than
 * inventing a second, differently-shaped confirmation mechanism. Passing no
 * requiredCount leaves every existing caller's behavior unchanged.
 */
export function computeConfirmation(
  color: Color,
  observationDate: string,
  prior: ConfirmationEntry | undefined,
  requiredCount = 2,
): ConfirmationEntry {
  if (!prior) {
    // First-ever run for this indicator — bootstrap, same pattern as
    // fed_pivot_signal/Warsh fields defaulting on a fresh crash_checks table.
    return { color, observation_date: observationDate, days_confirmed: 1, confirmed: 1 >= requiredCount, first_breach_date: observationDate };
  }
  if (observationDate === prior.observation_date) {
    if (color === prior.color) {
      // Same underlying data as last run (e.g. a same-day manual
      // re-trigger, no new observation has landed yet) — carry the state
      // forward as-is, don't double-count this as a second confirming date.
      return prior;
    }
    // Same date, but the value was revised to a different color (e.g. a
    // FRED same-day correction) — the prior entry's streak was built on
    // since-superseded data. Previously this branch didn't exist, so a
    // revised GREEN was masked by a stale confirmed-RED object (external
    // review 2026-09-19, F07). Treat the revision as this date's first true
    // observation of the corrected color: don't count it as an additional
    // independent observation (we can't reconstruct what came before this
    // date), but don't silently keep reporting the pre-revision color either.
    return { color, observation_date: observationDate, days_confirmed: 1, confirmed: 1 >= requiredCount, first_breach_date: observationDate };
  }
  if (color === prior.color) {
    const daysConfirmed = prior.days_confirmed + 1;
    return { color, observation_date: observationDate, days_confirmed: daysConfirmed, confirmed: daysConfirmed >= requiredCount, first_breach_date: prior.first_breach_date };
  }
  // Color changed on a new observation date — the streak resets.
  return { color, observation_date: observationDate, days_confirmed: 1, confirmed: 1 >= requiredCount, first_breach_date: observationDate };
}
