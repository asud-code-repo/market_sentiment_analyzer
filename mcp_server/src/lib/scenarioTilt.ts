// LLM scenario tilt (2026-11-17). The run's bull/base/bear/crash split is
// a frozen historical prior for its drawdown risk band, moved one fixed step
// by the LLM's tilt. The prior comes from config/scenario_prior_v1.json,
// built and frozen in the private research repo (experiments/
// h_scenario_prior); never hand-edit it and never retune it from live
// outcomes. The tilt rule below must match that experiment's tilt()
// exactly: scenarioTilt.test.ts replays the file's samples.
//
// Why: the free-judgment split moved up to 19 points on identical data,
// ran ~9 points above history, and could never be validated (a 6-month
// edge would take decades to confirm). A three-way tilt on a historical
// prior keeps the LLM's real contribution (what drawdown + VIX can't see)
// without the noise. See crash-check-rules.md, "Crash-Probability Scoring
// Methodology".

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const SCENARIO_PRIOR_PATH = fileURLToPath(new URL("../../../config/scenario_prior_v1.json", import.meta.url));
export const SCENARIO_METHOD = "tilt_v1";

export type Bucket = "bull" | "base" | "bear" | "crash";
export type Split = Record<Bucket, number>;
export type PriorState = "LOW" | "TRANSITIONING" | "HIGH" | "ALREADY_BREACHED";
export type Tilt = "lower" | "in_line" | "higher";
export const TILTS: readonly Tilt[] = ["lower", "in_line", "higher"];
const KEYS: readonly Bucket[] = ["bull", "base", "bear", "crash"];

export interface ScenarioPriorFile {
  name: string;
  version: string;
  horizon_trading_days: number;
  buckets: Record<string, string>;
  states: Record<string, string>;
  tilt: { step_pts: number };
  prior: Record<PriorState, { split: Split; days: number; fall10_episodes_approx: number }>;
  all_days: Split;
  provenance: Record<string, unknown>;
  samples: { state: PriorState; tilt: Tilt; split: Split }[];
  edge_samples: { prior: Split; tilt: "lower" | "higher"; split: Split }[];
}

export function loadScenarioPrior(path = SCENARIO_PRIOR_PATH): ScenarioPriorFile {
  const f = JSON.parse(readFileSync(path, "utf8")) as ScenarioPriorFile;
  for (const s of Object.keys(f.prior) as PriorState[]) {
    const sum = KEYS.reduce((a, k) => a + f.prior[s].split[k], 0);
    if (sum !== 100) throw new Error(`scenario prior ${s} sums to ${sum}, not 100 (${path})`);
  }
  return f;
}

/**
 * Same state the dashboard and get_indicator_panel show: ALREADY_BREACHED at
 * a 10%+ drawdown, otherwise the stored rule-engine band, or (older rows
 * with no stored band) the same formula: drawdown % + VIX / 5, cutoffs
 * 8.5 / 10 (rule_engine/src/hazardScorecard.ts). Null when inputs are missing.
 */
export function priorStateOf(drawdownPct: number | null, vix: number | null, storedBand: string | null): PriorState | null {
  if (drawdownPct == null) return null;
  if (drawdownPct >= 10) return "ALREADY_BREACHED";
  if (storedBand === "LOW" || storedBand === "TRANSITIONING" || storedBand === "HIGH") return storedBand;
  if (vix == null) return null;
  const score = drawdownPct + vix / 5;
  return score >= 10 ? "HIGH" : score >= 8.5 ? "TRANSITIONING" : "LOW";
}

/** Integers summing to `total`: floors first, then the remainder by largest fraction; ties in bull/base/bear/crash order. */
function largestRemainder(shares: Partial<Record<Bucket, number>>, total: number): Partial<Record<Bucket, number>> {
  const keys = KEYS.filter((k) => k in shares);
  const out: Partial<Record<Bucket, number>> = {};
  for (const k of keys) out[k] = Math.floor(shares[k]!);
  let left = total - keys.reduce((a, k) => a + out[k]!, 0);
  const order = [...keys].sort((a, b) => {
    const fa = shares[a]! - Math.floor(shares[a]!), fb = shares[b]! - Math.floor(shares[b]!);
    return fb - fa || KEYS.indexOf(a) - KEYS.indexOf(b);
  });
  for (const k of order) {
    if (left <= 0) break;
    out[k]! += 1;
    left--;
  }
  return out;
}

function allocate(amount: number, weights: Partial<Record<Bucket, number>>, fallback: Bucket): Partial<Record<Bucket, number>> {
  const keys = KEYS.filter((k) => k in weights);
  const tot = keys.reduce((a, k) => a + weights[k]!, 0);
  if (tot === 0) return Object.fromEntries(keys.map((k) => [k, k === fallback ? amount : 0]));
  return largestRemainder(Object.fromEntries(keys.map((k) => [k, (amount * weights[k]!) / tot])), amount);
}

/** Pure. Moves min(step, available) points between bull/base and bear/crash, each side in proportion to its prior sizes. */
export function applyTilt(split: Split, tilt: Tilt, step: number): Split {
  if (tilt === "in_line") return { ...split };
  const up: Bucket[] = ["bear", "crash"], down: Bucket[] = ["bull", "base"];
  const [src, dst, fallback] = tilt === "higher" ? [down, up, "bear" as Bucket] : [up, down, "base" as Bucket];
  const amount = Math.min(step, src.reduce((a, k) => a + split[k], 0));
  const take = allocate(amount, Object.fromEntries(src.map((k) => [k, split[k]])), src[0]);
  const give = allocate(amount, Object.fromEntries(dst.map((k) => [k, split[k]])), fallback);
  const out = { ...split };
  for (const k of src) out[k] -= take[k]!;
  for (const k of dst) out[k] += give[k]!;
  return out;
}

/** What get_indicator_panel serves in step 1, and write_snapshot re-derives in step 11. */
export function scenarioPriorFor(state: PriorState, file = loadScenarioPrior()) {
  const prior = file.prior[state];
  const step = file.tilt.step_pts;
  return {
    version: `${file.name}_${file.version}`,
    state,
    horizon_trading_days: file.horizon_trading_days,
    step_pts: step,
    prior: prior.split,
    history: { days: prior.days, fall10_episodes_approx: prior.fall10_episodes_approx, all_days_split: file.all_days },
    split_by_tilt: Object.fromEntries(TILTS.map((t) => [t, applyTilt(prior.split, t, step)])) as Record<Tilt, Split>,
    buckets: file.buckets,
  };
}

/**
 * Pure. A tilt away from in_line needs 1-3 reasons; in_line allows up to 3.
 * Every reason must cite a number (contain a digit) from steps 1-6.
 */
export function validateTiltReasons(tilt: Tilt, reasons: string[]): string[] {
  const errors: string[] = [];
  if (reasons.length > 3) errors.push(`At most 3 tilt reasons, got ${reasons.length}.`);
  if (tilt !== "in_line" && reasons.length === 0) errors.push(`A "${tilt}" tilt needs 1-3 reasons, each citing a number from steps 1-6.`);
  reasons.forEach((r, i) => {
    if (!/\d/.test(r)) errors.push(`Tilt reason ${i + 1} cites no number: "${r}". Quote the figure it rests on.`);
  });
  return errors;
}
