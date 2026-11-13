// Mirrors reference_docs/rules/crash-check-rules.md — the 6-indicator bands
// and wave-authorization thresholds. If you edit the rules doc, mirror the
// change here. This file intentionally contains no LLM/qualitative logic:
// every function here is a pure, deterministic mapping from numbers to bands.

export type Color = "GREEN" | "AMBER" | "RED";

/**
 * The 5 numeric panel bands — the single code source for these thresholds
 * (exported 2026-11-13 for distance-to-RED, build spec E7, so nothing else
 * needs to hardcode them). Every band has the same shape: GREEN below
 * `amber_from`; AMBER from `amber_from` up to AND INCLUDING `red_above`;
 * RED only when strictly above `red_above`.
 */
export interface BandThresholds {
  amber_from: number;
  red_above: number;
}

export type NumericIndicator = "vix" | "hy_spread" | "sp_drawdown" | "treasury_10y" | "sahm_rule";

export const PANEL_BANDS: Record<NumericIndicator, BandThresholds> = {
  vix: { amber_from: 20, red_above: 35 },
  hy_spread: { amber_from: 350, red_above: 500 }, // bps
  sp_drawdown: { amber_from: 10, red_above: 20 }, // % below ATH
  treasury_10y: { amber_from: 4.3, red_above: 5.0 }, // %
  sahm_rule: { amber_from: 0.3, red_above: 0.5 },
};

/** Distinct observation dates a color must hold before it counts (Signal Tiering). */
export const CONFIRMATION_REQUIRED_DAYS = 2;

function bandByThresholds(value: number, t: BandThresholds): Color {
  if (value < t.amber_from) return "GREEN";
  if (value <= t.red_above) return "AMBER";
  return "RED";
}

export function bandVix(value: number): Color {
  return bandByThresholds(value, PANEL_BANDS.vix);
}

/** Expects bps (e.g. 290, not 2.90) — convert FRED's percent reading before calling. */
export function bandHySpreadBps(bps: number): Color {
  return bandByThresholds(bps, PANEL_BANDS.hy_spread);
}

export function bandSpDrawdownPct(drawdownPct: number): Color {
  return bandByThresholds(drawdownPct, PANEL_BANDS.sp_drawdown);
}

export function bandTreasury10y(pct: number): Color {
  return bandByThresholds(pct, PANEL_BANDS.treasury_10y);
}

export function bandSahmRule(value: number): Color {
  return bandByThresholds(value, PANEL_BANDS.sahm_rule);
}

export function bandFedPivotSignal(signal: "NONE" | "PAUSE" | "CUT"): Color {
  if (signal === "NONE") return "GREEN";
  if (signal === "PAUSE") return "AMBER";
  return "RED";
}

export function countReds(colors: Color[]): number {
  return colors.filter((c) => c === "RED").length;
}

/**
 * Wave deployment is authorized when 3+ of the 6 indicators are RED.
 * Mirrored in mcp_server/src/lib/supabase.ts's `waveAuthorized` calc
 * (duplicated rather than shared, per this codebase's convention) — if you
 * change this threshold, update that copy too.
 */
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
  requiredCount = CONFIRMATION_REQUIRED_DAYS,
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

/**
 * Distance-to-RED (build spec E7, 2026-11-13): for each numeric panel
 * indicator, how far today's reading is from its AMBER and RED lines.
 * Deterministic and judgment-free; the thresholds come from PANEL_BANDS
 * above, never restated. Persisted daily to crash_checks.distance_to_red
 * and read by get_indicator_panel and dashboard_site. Never feeds red_count
 * or wave logic.
 *
 * Sign convention: distance = line - value, in the indicator's own units.
 * Positive = still below the line. Because RED is strictly ABOVE
 * red_above, distance_to_red = 0 still reads AMBER. pct_move_to_* is the %
 * move in the underlying needed to reach the line; for S&P drawdown that's
 * the move in the S&P 500 level itself (negative = a fall), not a % of a %.
 * Null when the base is not positive (no meaningful % move).
 */
export interface IndicatorDistance {
  value: number;
  observation_date: string;
  color: Color;
  amber_from: number;
  red_above: number;
  distance_to_amber: number;
  distance_to_red: number;
  pct_move_to_amber: number | null;
  pct_move_to_red: number | null;
  /** Consecutive confirming observation dates at RED so far (0 when not RED). */
  red_days_confirmed: number;
  /** More observation dates at RED needed before it counts (0 = confirmed RED). */
  red_confirmation_days_needed: number;
}

export interface DistanceToRed {
  required_confirmation_days: number;
  indicators: Record<NumericIndicator, IndicatorDistance>;
  /** No numeric series: a state, not a distance. */
  fed_pivot_signal: { state: "NONE" | "PAUSE" | "CUT"; color: Color; amber_state: "PAUSE"; red_state: "CUT" };
}

export interface DistanceInput {
  value: number;
  observation_date: string;
  confirmation: ConfirmationEntry;
}

const round = (n: number, dp: number) => Math.round(n * 10 ** dp) / 10 ** dp;

function pctMove(from: number, to: number): number | null {
  return from > 0 ? round((to / from - 1) * 100, 2) : null;
}

export function computeDistanceToRed(
  inputs: Record<NumericIndicator, DistanceInput>,
  sp500: { level: number; ath: number },
  fedPivot: { state: "NONE" | "PAUSE" | "CUT"; color: Color },
): DistanceToRed {
  const indicators = {} as Record<NumericIndicator, IndicatorDistance>;
  for (const key of Object.keys(PANEL_BANDS) as NumericIndicator[]) {
    const { value, observation_date, confirmation } = inputs[key];
    const t = PANEL_BANDS[key];
    const color = bandByThresholds(value, t);
    // S&P drawdown: express the % move as the S&P level change that would
    // put the drawdown exactly on the line, ath * (1 - line/100).
    const moveTo = (line: number) =>
      key === "sp_drawdown" ? pctMove(sp500.level, sp500.ath * (1 - line / 100)) : pctMove(value, line);
    const redDays = color === "RED" && confirmation.color === "RED" ? confirmation.days_confirmed : 0;
    indicators[key] = {
      value,
      observation_date,
      color,
      amber_from: t.amber_from,
      red_above: t.red_above,
      distance_to_amber: round(t.amber_from - value, 4),
      distance_to_red: round(t.red_above - value, 4),
      pct_move_to_amber: moveTo(t.amber_from),
      pct_move_to_red: moveTo(t.red_above),
      red_days_confirmed: redDays,
      red_confirmation_days_needed: Math.max(0, CONFIRMATION_REQUIRED_DAYS - redDays),
    };
  }
  return {
    required_confirmation_days: CONFIRMATION_REQUIRED_DAYS,
    indicators,
    fed_pivot_signal: { state: fedPivot.state, color: fedPivot.color, amber_state: "PAUSE", red_state: "CUT" },
  };
}
