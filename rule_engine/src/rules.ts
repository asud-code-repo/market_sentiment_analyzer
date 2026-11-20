// The 6-indicator bands and the stress gate. Threshold VALUES load from
// config/monitoring.yaml (shared with mcp_server; rationale in
// reference_docs/rules/crash-check-rules.md). This file intentionally
// contains no LLM/qualitative logic: every function here is a pure,
// deterministic mapping from numbers to bands.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";

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

export interface MonitoringConfig {
  panel_bands: Record<NumericIndicator, BandThresholds>;
  confirmation_required_days: number;
  stress_gate_confirmed_reds: number;
  /** Whether deployment requires the gate (read by mcp_server get_deployment_plan; validated here too). */
  stress_gate_required: boolean;
}

export const MONITORING_CONFIG_PATH = fileURLToPath(new URL("../../config/monitoring.yaml", import.meta.url));

const NUMERIC_INDICATORS: readonly NumericIndicator[] = ["vix", "hy_spread", "sp_drawdown", "treasury_10y", "sahm_rule"];

/** Validates a parsed monitoring config; throws listing every problem (fail loud, never default). */
export function parseMonitoringConfig(raw: unknown, source = "monitoring config"): MonitoringConfig {
  const problems: string[] = [];
  const r = (raw ?? {}) as Record<string, unknown>;
  const isInt = (v: unknown, min: number, max: number) => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
  if (r.schema_version !== 1) problems.push("schema_version must be 1");
  const bands = (r.panel_bands ?? {}) as Record<string, { amber_from?: unknown; red_above?: unknown }>;
  for (const k of NUMERIC_INDICATORS) {
    const b = bands[k];
    if (!b || typeof b.amber_from !== "number" || typeof b.red_above !== "number") problems.push(`panel_bands.${k} needs numeric amber_from and red_above`);
    else if (b.amber_from >= b.red_above) problems.push(`panel_bands.${k}: amber_from must be below red_above`);
  }
  for (const k of Object.keys(bands)) if (!NUMERIC_INDICATORS.includes(k as NumericIndicator)) problems.push(`panel_bands.${k} is not a known indicator`);
  if (!isInt(r.confirmation_required_days, 1, 30)) problems.push("confirmation_required_days must be an integer from 1 to 30");
  if (!isInt(r.stress_gate_confirmed_reds, 1, 6)) problems.push("stress_gate_confirmed_reds must be an integer from 1 to 6");
  if (typeof r.stress_gate_required !== "boolean") problems.push("stress_gate_required must be true or false");
  if (problems.length) throw new Error(`${source} is invalid — ${problems.join("; ")}`);
  return {
    panel_bands: Object.fromEntries(
      NUMERIC_INDICATORS.map((k) => [k, { amber_from: bands[k].amber_from as number, red_above: bands[k].red_above as number }]),
    ) as Record<NumericIndicator, BandThresholds>,
    confirmation_required_days: r.confirmation_required_days as number,
    stress_gate_confirmed_reds: r.stress_gate_confirmed_reds as number,
    stress_gate_required: r.stress_gate_required as boolean,
  };
}

/** Loaded once at import: a classify run must use one consistent set of thresholds. */
export const MONITORING: MonitoringConfig = parseMonitoringConfig(
  load(readFileSync(MONITORING_CONFIG_PATH, "utf-8")),
  MONITORING_CONFIG_PATH,
);

export const PANEL_BANDS: Record<NumericIndicator, BandThresholds> = MONITORING.panel_bands;

/** Distinct observation dates a color must hold before it counts (Signal Tiering). */
export const CONFIRMATION_REQUIRED_DAYS = MONITORING.confirmation_required_days;

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
 * Wave deployment is authorized when at least `stress_gate_confirmed_reds`
 * (config/monitoring.yaml) of the 6 indicators are confirmed RED.
 * mcp_server/src/lib/supabase.ts reads the same config value.
 */
export function isWaveAuthorized(redCount: number): boolean {
  return redCount >= MONITORING.stress_gate_confirmed_reds;
}

// Wave triggers (which wave, by drawdown/VIX or the slow-bear pathway) are
// personal policy and are evaluated locally by mcp_server
// (src/lib/waveEvaluation.ts, thresholds in local_state/policy.yaml). The
// rule engine publishes only their public market inputs: drawdown, VIX and
// sp500_days_since_252d_low.

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
