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

export function drawdownPct(level: number, ath: number): number {
  return ((ath - level) / ath) * 100;
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

export function computeConfirmation(
  color: Color,
  observationDate: string,
  prior: ConfirmationEntry | undefined,
): ConfirmationEntry {
  if (!prior) {
    // First-ever run for this indicator — bootstrap, same pattern as
    // fed_pivot_signal/Warsh fields defaulting on a fresh crash_checks table.
    return { color, observation_date: observationDate, days_confirmed: 1, confirmed: false, first_breach_date: observationDate };
  }
  if (observationDate === prior.observation_date) {
    // Same underlying data as last run (e.g. a same-day manual re-trigger,
    // no new observation has landed yet) — carry the state forward as-is,
    // don't double-count this as a second confirming date.
    return prior;
  }
  if (color === prior.color) {
    const daysConfirmed = prior.days_confirmed + 1;
    return { color, observation_date: observationDate, days_confirmed: daysConfirmed, confirmed: daysConfirmed >= 2, first_breach_date: prior.first_breach_date };
  }
  // Color changed on a new observation date — the streak resets.
  return { color, observation_date: observationDate, days_confirmed: 1, confirmed: false, first_breach_date: observationDate };
}
