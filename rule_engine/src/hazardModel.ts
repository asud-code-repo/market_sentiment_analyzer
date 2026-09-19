// Hardcoded port of a logistic-regression "hazard model": P(S&P drawdown
// reaches >=10% from ATH within 21 trading days | not already past that
// threshold). The ORIGINAL RESEARCH CLAIMED walk-forward validation
// (expanding window, leave-one-crisis-out: dot-com/GFC/Dec-2018/COVID/2022),
// isotonic recalibration (stratified 5-fold on pooled out-of-sample
// predictions), and a block-bootstrap CI confirming a real edge over the
// historical base rate for THIS target specifically (plus a companion 20%
// target that was tested and shelved — its CI spanned zero, given only 4
// usable real episodes — not represented here).
//
// STATUS (confirmed 2026-09-19, external review + a follow-up search of
// this repo): the original training script/notebook, this artifact's
// derivation, the label/fold definitions, and the bootstrap output are not
// recoverable from anything in this repository. The paragraph above
// describes what the original research CLAIMED, not something currently
// independently verifiable — treat it as documented, not established.
// Reproducing it would be a full rebuild from raw data (point-in-time
// FRED/SPY reconstruction, refit, leakage-safe backtest against simple
// baselines), not a recovery of existing work. See
// reference_docs/rules/crash-check-rules.md's "Statistical Hazard Model"
// section for the full writeup (same caveat applies there).
//
// DO NOT hand-edit FEATURES/INTERCEPT/ISOTONIC_TABLE below — they are a
// direct, byte-for-byte port of the trained artifact
// (hazard_model_10pct_artifact.json, produced 2026-08-26). Regenerate this
// whole block from a fresh retrain if the model ever changes; do not tweak
// individual numbers.
//
// TRADING-DAY-EXACT DELTAS (fixed 2026-09-15, previously a flagged 7/28
// calendar-day approximation): the research validated 5-trading-day/
// 20-trading-day deltas. Production now matches exactly, via
// getTradingDayAnchor() (seriesDelta.ts) counting back rows in SP500 as the
// market-calendar reference rather than approximating with calendar-day
// subtraction. External review (2026-09-15) flagged the prior approximation
// as an avoidable research-to-production mismatch, especially since a small
// raw-score movement can cross a plateau boundary in the isotonic
// calibration curve — worth closing properly rather than leaving flagged.
//
// SIGN CONVENTION: rules.ts's drawdownPct() returns a POSITIVE number for a
// drawdown (e.g. 8.5 for an 8.5% decline). The model was trained on the
// opposite convention (negative — e.g. -8.5), matching how a %-from-ATH
// series naturally reads (0 at the all-time high, negative below it). Every
// use of drawdown below negates rules.ts's convention to match training —
// get this wrong and every drawdown-derived feature (drawdown_pct and both
// its deltas) is silently backwards.

import { supabase, getLatestDataPoint } from "./lib/supabase.js";
import { getValueOnOrBefore, computeSeriesDeltaAsOfDate, getTradingDayAnchor } from "./lib/seriesDelta.js";
import { drawdownPct } from "./rules.js";

interface FeatureCoefficient {
  name: string;
  scaler_mean: number;
  scaler_scale: number;
  coefficient: number;
}

const FEATURES: FeatureCoefficient[] = [
  { name: "drawdown_pct", scaler_mean: -2.713563, scaler_scale: 2.748543, coefficient: -0.79511 },
  { name: "BAA10Y", scaler_mean: 2.044754, scaler_scale: 0.479877, coefficient: 0.438947 },
  { name: "CCSA", scaler_mean: 2558824.202288, scaler_scale: 1796969.154907, coefficient: 0.051867 },
  { name: "CPIAUCSL", scaler_mean: 226.532922, scaler_scale: 55.621446, coefficient: 0.031036 },
  { name: "DCOILWTICO", scaler_mean: 52.597421, scaler_scale: 27.842448, coefficient: 0.075114 },
  { name: "DGS10", scaler_mean: 3.946313, scaler_scale: 1.935879, coefficient: -0.170419 },
  { name: "DRCCLACBS", scaler_mean: 3.179902, scaler_scale: 0.991072, coefficient: 0.106404 },
  { name: "DRTSCILM", scaler_mean: 1.256733, scaler_scale: 16.975203, coefficient: -0.267303 },
  { name: "ICSA", scaler_mean: 316259.883604, scaler_scale: 149882.176249, coefficient: -0.06673 },
  { name: "NFCI", scaler_mean: -0.515731, scaler_scale: 0.21454, coefficient: 0.202546 },
  { name: "RECPROUSM156N", scaler_mean: 0.571925, scaler_scale: 3.788742, coefficient: 0.306206 },
  { name: "RSAFS", scaler_mean: 422334.983343, scaler_scale: 172833.332752, coefficient: -0.017693 },
  { name: "SAHMREALTIME", scaler_mean: 0.221136, scaler_scale: 1.059673, coefficient: 0.079656 },
  { name: "STLFSI4", scaler_mean: -0.268636, scaler_scale: 0.429727, coefficient: -0.192689 },
  { name: "UNRATE", scaler_mean: 5.00588, scaler_scale: 1.196191, coefficient: -0.067876 },
  { name: "VIXCLS", scaler_mean: 17.295736, scaler_scale: 5.048528, coefficient: 0.064238 },
  { name: "curve_2s10s", scaler_mean: 0.664718, scaler_scale: 0.696703, coefficient: -0.392045 },
  { name: "spy_realized_vol_20d", scaler_mean: 13.36249, scaler_scale: 5.919794, coefficient: 0.238564 },
  { name: "VIXCLS_d5", scaler_mean: -0.029021, scaler_scale: 2.67617, coefficient: 0.034908 },
  { name: "VIXCLS_d20", scaler_mean: -0.120375, scaler_scale: 4.073969, coefficient: -0.063834 },
  { name: "drawdown_pct_d5", scaler_mean: 0.07417, scaler_scale: 1.67882, coefficient: -0.044924 },
  { name: "drawdown_pct_d20", scaler_mean: 0.262406, scaler_scale: 2.881353, coefficient: -0.094187 },
  { name: "BAA10Y_d5", scaler_mean: -0.003418, scaler_scale: 0.054998, coefficient: -0.003188 },
  { name: "BAA10Y_d20", scaler_mean: -0.014349, scaler_scale: 0.121728, coefficient: 0.174878 },
  { name: "NFCI_d5", scaler_mean: 0.00093, scaler_scale: 0.017822, coefficient: 0.324732 },
  { name: "NFCI_d20", scaler_mean: 0.002069, scaler_scale: 0.064816, coefficient: -0.082168 },
  { name: "STLFSI4_d5", scaler_mean: -0.002726, scaler_scale: 0.182308, coefficient: 0.059485 },
  { name: "STLFSI4_d20", scaler_mean: -0.007576, scaler_scale: 0.280476, coefficient: -0.139465 },
  { name: "DGS10_d5", scaler_mean: 0.003267, scaler_scale: 0.112369, coefficient: 0.091392 },
  { name: "DGS10_d20", scaler_mean: 0.013594, scaler_scale: 0.221355, coefficient: 0.233178 },
  { name: "curve_2s10s_d5", scaler_mean: -0.001569, scaler_scale: 0.065586, coefficient: 0.011247 },
  { name: "curve_2s10s_d20", scaler_mean: -0.006099, scaler_scale: 0.13241, coefficient: -0.182815 },
];

const INTERCEPT = -2.557114;

const ISOTONIC_TABLE: { raw: number; calibrated: number }[] = [
  { raw: 0.0, calibrated: 0.2222 },
  { raw: 0.0, calibrated: 0.2222 },
  { raw: 0.0, calibrated: 0.2366 },
  { raw: 0.1518, calibrated: 0.2366 },
  { raw: 0.153, calibrated: 0.375 },
  { raw: 0.1791, calibrated: 0.375 },
  { raw: 0.182, calibrated: 0.5455 },
  { raw: 0.1984, calibrated: 0.5455 },
  { raw: 0.1997, calibrated: 0.6667 },
  { raw: 0.2058, calibrated: 0.6667 },
  { raw: 0.2059, calibrated: 0.8 },
  { raw: 0.2174, calibrated: 0.8 },
  { raw: 0.2186, calibrated: 0.8571 },
  { raw: 0.2527, calibrated: 0.8571 },
  { raw: 0.2569, calibrated: 0.927 },
  { raw: 0.8259, calibrated: 0.927 },
  { raw: 0.8285, calibrated: 1.0 },
  { raw: 1.0, calibrated: 1.0 },
];

export type HazardBand = "LOW" | "TRANSITIONING" | "HIGH";

export interface HazardResult {
  raw_probability: number;
  calibrated_probability: number;
  band: HazardBand;
}

/**
 * Pure — no I/O. Given the 32 raw (unstandardized) feature values, replays
 * standardize -> logit -> sigmoid -> isotonic-interpolate exactly, matching
 * the artifact's own inference_steps and the Python sanity check that
 * verified this reproduces sklearn's predict_proba exactly.
 */
export function computeHazardProbability(rawValues: Record<string, number>): HazardResult {
  let logit = INTERCEPT;
  for (const f of FEATURES) {
    const value = rawValues[f.name];
    if (value === undefined || Number.isNaN(value)) {
      throw new Error(`computeHazardProbability: missing feature "${f.name}"`);
    }
    logit += ((value - f.scaler_mean) / f.scaler_scale) * f.coefficient;
  }
  const rawProbability = 1 / (1 + Math.exp(-logit));
  const calibratedProbability = interpolateIsotonic(rawProbability);
  return {
    raw_probability: rawProbability,
    calibrated_probability: calibratedProbability,
    band: bandHazard(calibratedProbability),
  };
}

function interpolateIsotonic(raw: number): number {
  const table = ISOTONIC_TABLE;
  if (raw <= table[0].raw) return table[0].calibrated;
  const last = table[table.length - 1];
  if (raw >= last.raw) return last.calibrated;
  for (let i = 0; i < table.length - 1; i++) {
    const a = table[i];
    const b = table[i + 1];
    if (raw >= a.raw && raw <= b.raw) {
      if (b.raw === a.raw) return b.calibrated; // degenerate zero-width segment (duplicate breakpoints in the source table)
      const t = (raw - a.raw) / (b.raw - a.raw);
      return a.calibrated + t * (b.calibrated - a.calibrated);
    }
  }
  return last.calibrated; // unreachable given the two guards above
}

/**
 * Cutoffs on the CALIBRATED probability, chosen to align with the
 * calibration curve's own plateau structure (two wide flat plateaus at
 * ~22-24% and ~93%, with real differentiation packed into the 15-26%
 * raw-score band between them) — not evenly spaced, not a RAG-style band,
 * deliberately distinct from the discretionary crash-probability meter's
 * green/amber/red thresholds.
 */
export function bandHazard(calibratedProbability: number): HazardBand {
  const pct = calibratedProbability * 100;
  if (pct < 35) return "LOW";
  if (pct < 90) return "TRANSITIONING";
  return "HIGH";
}

// ---- Feature gathering (I/O) ----

const round = (n: number) => Math.round(n * 100000) / 100000;

async function requireLevel(seriesId: string): Promise<{ value: number; observation_date: string }> {
  const point = await getLatestDataPoint(seriesId);
  if (!point) {
    throw new Error(
      `hazardModel: no data_points row for required series "${seriesId}" — has ingestion run since it was added?`,
    );
  }
  return point;
}

async function getDrawdownAsOf(dateStr: string): Promise<number> {
  const [level, ath] = await Promise.all([
    getValueOnOrBefore("SP500", dateStr),
    getValueOnOrBefore("SP500_ATH", dateStr),
  ]);
  if (level === null || ath === null) {
    throw new Error(`hazardModel: missing SP500/SP500_ATH history on/before ${dateStr}`);
  }
  // Negate to the model's training convention — see file header.
  return -drawdownPct(level, ath);
}

async function getCurveAsOf(dateStr: string): Promise<number> {
  const [d10, d2] = await Promise.all([
    getValueOnOrBefore("DGS10", dateStr),
    getValueOnOrBefore("DGS2", dateStr),
  ]);
  if (d10 === null || d2 === null) {
    throw new Error(`hazardModel: missing DGS10/DGS2 history on/before ${dateStr}`);
  }
  return d10 - d2;
}

/**
 * Stdev of the last 20 LOG daily returns of SP500 (FRED index — the same S&P
 * proxy this system already uses everywhere for drawdown/ATH/wave triggers,
 * not a new SPY-vs-SP500 substitution introduced by this feature
 * specifically), annualized. Must match the original research exactly:
 * log returns (not simple), sample stdev (ddof=1, pandas .std()'s default),
 * x sqrt(252) x 100 — a silent formula mismatch here would produce a
 * subtly-wrong number without erroring, since this is the one feature
 * computed from scratch rather than read verbatim from an artifact table.
 */
async function getSp500RealizedVol20d(anchorDate: string): Promise<number> {
  const { data, error } = await supabase
    .from("data_points")
    .select("value")
    .eq("series_id", "SP500")
    .lte("observation_date", anchorDate)
    .order("observation_date", { ascending: false })
    .limit(21);
  if (error) {
    throw new Error(`hazardModel: failed reading SP500 history for realized vol: ${error.message}`);
  }
  if (!data || data.length < 21) {
    throw new Error(`hazardModel: fewer than 21 SP500 rows on/before ${anchorDate} — cannot compute 20d realized vol yet.`);
  }
  const closes = data.map((r) => r.value as number).reverse(); // ascending by date
  const logReturns: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    logReturns.push(Math.log(closes[i] / closes[i - 1]));
  }
  const mean = logReturns.reduce((a, b) => a + b, 0) / logReturns.length;
  const variance = logReturns.reduce((a, r) => a + (r - mean) ** 2, 0) / (logReturns.length - 1); // sample stdev, ddof=1
  return Math.sqrt(variance) * Math.sqrt(252) * 100;
}

/**
 * Context of values classify.ts has already fetched this run — reused
 * rather than re-queried, matching this codebase's existing convention of
 * not re-fetching what the caller already has. vixValue/dgs10Value/
 * sahmValue are the live-convention values as-is; drawdownPctLive is
 * rules.ts's drawdownPct() output (POSITIVE for a drawdown) — this module
 * negates it internally to match the model's training convention.
 */
export interface HazardContext {
  vixValue: number;
  dgs10Value: number;
  sahmValue: number;
  drawdownPctLive: number;
  anchorDate: string; // sp500.observation_date — the same anchor classify.ts uses elsewhere
}

/**
 * Fetches the remaining raw levels + all deltas, combines with the
 * caller-supplied context, and returns the full 32-entry raw feature vector
 * computeHazardProbability expects. Fails loud (throws) on any missing
 * series/history, matching requireLatest's fail-loud convention elsewhere in
 * classify.ts — a hazard number computed from a partially missing feature
 * vector would be actively wrong, not just incomplete. classify.ts wraps
 * the call to this function in a try/catch so a hazard-specific failure
 * degrades to null fields rather than blocking the core 6-indicator panel.
 */
export async function gatherHazardFeatures(ctx: HazardContext): Promise<Record<string, number>> {
  const [baa10y, ccsa, cpiaucsl, dcoilwtico, drcclacbs, drtscilm, icsa, nfci, recprousm156n, rsafs, stlfsi4, unrate, dgs2] =
    await Promise.all([
      requireLevel("BAA10Y"),
      requireLevel("CCSA"),
      requireLevel("CPIAUCSL"),
      requireLevel("DCOILWTICO"),
      requireLevel("DRCCLACBS"),
      requireLevel("DRTSCILM"),
      requireLevel("ICSA"),
      requireLevel("NFCI"),
      requireLevel("RECPROUSM156N"),
      requireLevel("RSAFS"),
      requireLevel("STLFSI4"),
      requireLevel("UNRATE"),
      requireLevel("DGS2"),
    ]);

  const drawdownPctModel = -ctx.drawdownPctLive; // negate to training convention
  const curve2s10s = ctx.dgs10Value - dgs2.value;

  // Trading-day-exact anchors (resolved once, reused below) — closes the
  // previously-flagged calendar-day approximation (crash-check-rules.md's
  // "Known production approximation": research was validated on exact
  // 5/20-trading-day deltas, production used 7/28 calendar days instead).
  // See getTradingDayAnchor's own doc comment for how "trading day" is
  // determined (counting back rows in SP500, this system's market-calendar
  // reference series).
  const [date5, date20] = await Promise.all([
    getTradingDayAnchor(ctx.anchorDate, 5),
    getTradingDayAnchor(ctx.anchorDate, 20),
  ]);

  const [realizedVol20d, vixD5, vixD20, baaD5, baaD20, nfciD5, nfciD20, stlfsiD5, stlfsiD20, dgs10D5, dgs10D20, drawdown5, drawdown20, curve5, curve20] =
    await Promise.all([
      getSp500RealizedVol20d(ctx.anchorDate),
      computeSeriesDeltaAsOfDate("VIXCLS", ctx.vixValue, date5),
      computeSeriesDeltaAsOfDate("VIXCLS", ctx.vixValue, date20),
      computeSeriesDeltaAsOfDate("BAA10Y", baa10y.value, date5),
      computeSeriesDeltaAsOfDate("BAA10Y", baa10y.value, date20),
      computeSeriesDeltaAsOfDate("NFCI", nfci.value, date5),
      computeSeriesDeltaAsOfDate("NFCI", nfci.value, date20),
      computeSeriesDeltaAsOfDate("STLFSI4", stlfsi4.value, date5),
      computeSeriesDeltaAsOfDate("STLFSI4", stlfsi4.value, date20),
      computeSeriesDeltaAsOfDate("DGS10", ctx.dgs10Value, date5),
      computeSeriesDeltaAsOfDate("DGS10", ctx.dgs10Value, date20),
      getDrawdownAsOf(date5),
      getDrawdownAsOf(date20),
      getCurveAsOf(date5),
      getCurveAsOf(date20),
    ]);

  return {
    drawdown_pct: drawdownPctModel,
    BAA10Y: baa10y.value,
    CCSA: ccsa.value,
    CPIAUCSL: cpiaucsl.value,
    DCOILWTICO: dcoilwtico.value,
    DGS10: ctx.dgs10Value,
    DRCCLACBS: drcclacbs.value,
    DRTSCILM: drtscilm.value,
    ICSA: icsa.value,
    NFCI: nfci.value,
    RECPROUSM156N: recprousm156n.value,
    RSAFS: rsafs.value,
    SAHMREALTIME: ctx.sahmValue,
    STLFSI4: stlfsi4.value,
    UNRATE: unrate.value,
    VIXCLS: ctx.vixValue,
    curve_2s10s: curve2s10s,
    spy_realized_vol_20d: realizedVol20d,
    VIXCLS_d5: vixD5,
    VIXCLS_d20: vixD20,
    drawdown_pct_d5: round(drawdownPctModel - drawdown5),
    drawdown_pct_d20: round(drawdownPctModel - drawdown20),
    BAA10Y_d5: baaD5,
    BAA10Y_d20: baaD20,
    NFCI_d5: nfciD5,
    NFCI_d20: nfciD20,
    STLFSI4_d5: stlfsiD5,
    STLFSI4_d20: stlfsiD20,
    DGS10_d5: dgs10D5,
    DGS10_d20: dgs10D20,
    curve_2s10s_d5: round(curve2s10s - curve5),
    curve_2s10s_d20: round(curve2s10s - curve20),
  };
}
