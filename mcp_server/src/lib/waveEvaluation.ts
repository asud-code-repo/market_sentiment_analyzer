// Wave evaluation, run locally (moved from rule_engine/src/classify.ts on
// 2026-11-14). The trigger levels are personal policy
// (local_state/policy.yaml `wave_triggers`), so they never reach GitHub
// Actions or the public crash_checks table. The inputs are public market
// readings the rule engine already publishes on every row: S&P drawdown %,
// VIX, and sp500_days_since_252d_low.
//
// Two pathways, exactly as before:
// - fast_panic: same-day drawdown AND VIX, deepest wave first.
// - slow_bear (Wave 2/3 only): drawdown AND a fresh 252-day low within the
//   freshness window, confirmed over `requiredDays` distinct observation
//   dates. Confirmation is rebuilt by replaying the public row history in
//   run_at order with the same computeConfirmation the rule engine used,
//   so the result matches what classify() would have stored.
// Whichever pathway reaches the higher wave wins; a tie reports FAST_PANIC.

import type { Policy, Wave } from "./waveDeployment.js";

export type Color = "GREEN" | "AMBER" | "RED";
export type WaveActive = Wave | "NONE";

export interface ConfirmationEntry {
  color: Color;
  observation_date: string;
  days_confirmed: number;
  confirmed: boolean;
  first_breach_date: string;
}

/** One public crash_checks row's wave inputs. */
export interface WaveInputRow {
  run_at: string;
  observation_date: string | null; // the S&P reading's own date
  drawdown_pct: number | null;
  vix: number | null;
  days_since_252d_low: number | null;
}

export interface WaveStatus {
  wave_active: WaveActive;
  wave_active_reason: "FAST_PANIC" | "SLOW_BEAR" | null;
  fast_panic_wave: WaveActive;
  slow_bear: { w2: ConfirmationEntry | null; w3: ConfirmationEntry | null };
  as_of_run_at: string | null;
  as_of_observation_date: string | null;
}

/** Same semantics as rule_engine/src/rules.ts computeConfirmation (duplicated, not shared). */
export function computeConfirmation(
  color: Color,
  observationDate: string,
  prior: ConfirmationEntry | undefined | null,
  requiredCount: number,
): ConfirmationEntry {
  const fresh = (): ConfirmationEntry => ({
    color,
    observation_date: observationDate,
    days_confirmed: 1,
    confirmed: 1 >= requiredCount,
    first_breach_date: observationDate,
  });
  if (!prior) return fresh();
  if (observationDate === prior.observation_date) return color === prior.color ? prior : fresh();
  if (color === prior.color) {
    const days = prior.days_confirmed + 1;
    return { color, observation_date: observationDate, days_confirmed: days, confirmed: days >= requiredCount, first_breach_date: prior.first_breach_date };
  }
  return fresh();
}

const RANK: Record<WaveActive, number> = { NONE: 0, WAVE_1: 1, WAVE_2: 2, WAVE_3: 3 };

export function fastPanicWave(drawdownPct: number, vix: number, t: Policy["wave_triggers"]): WaveActive {
  for (const w of ["WAVE_3", "WAVE_2", "WAVE_1"] as const) {
    const trig = t.fast_panic[w];
    if (drawdownPct >= trig.drawdown_pct_gte && vix > trig.vix_gt) return w;
  }
  return "NONE";
}

export function slowBearConditions(drawdownPct: number, daysSinceLow: number, t: Policy["wave_triggers"]): { w2: boolean; w3: boolean } {
  const fresh = daysSinceLow <= t.slow_bear.freshness_window_trading_days;
  return {
    w2: fresh && drawdownPct >= t.slow_bear.WAVE_2.drawdown_pct_gte,
    w3: fresh && drawdownPct >= t.slow_bear.WAVE_3.drawdown_pct_gte,
  };
}

/**
 * Replays rows (ascending run_at) and returns the wave status after each
 * one. Rows missing an input are skipped for the slow-bear streak, and
 * their fast-panic result is NONE. A missing days_since_252d_low counts as
 * "not fresh", the same sentinel classify() used.
 */
export function evaluateWaveHistory(rows: WaveInputRow[], policy: Policy, requiredDays: number): WaveStatus[] {
  const t = policy.wave_triggers;
  let w2: ConfirmationEntry | null = null;
  let w3: ConfirmationEntry | null = null;
  const out: WaveStatus[] = [];
  for (const r of rows) {
    let fast: WaveActive = "NONE";
    if (r.drawdown_pct !== null && r.observation_date) {
      const days = r.days_since_252d_low ?? 9999;
      const c = slowBearConditions(r.drawdown_pct, days, t);
      w2 = computeConfirmation(c.w2 ? "RED" : "GREEN", r.observation_date, w2, requiredDays);
      w3 = computeConfirmation(c.w3 ? "RED" : "GREEN", r.observation_date, w3, requiredDays);
      if (r.vix !== null) fast = fastPanicWave(r.drawdown_pct, r.vix, t);
    }
    const slow: WaveActive =
      w3?.color === "RED" && w3.confirmed ? "WAVE_3" : w2?.color === "RED" && w2.confirmed ? "WAVE_2" : "NONE";
    const fastWins = RANK[fast] >= RANK[slow];
    const active = fastWins ? fast : slow;
    out.push({
      wave_active: active,
      wave_active_reason: active === "NONE" ? null : fastWins ? "FAST_PANIC" : "SLOW_BEAR",
      fast_panic_wave: fast,
      slow_bear: { w2, w3 },
      as_of_run_at: r.run_at,
      as_of_observation_date: r.observation_date,
    });
  }
  return out;
}

/** Wave status after the latest row; NONE with null dates when there's no history. */
export function evaluateCurrentWave(rows: WaveInputRow[], policy: Policy, requiredDays: number): WaveStatus {
  const all = evaluateWaveHistory(rows, policy, requiredDays);
  return (
    all[all.length - 1] ?? {
      wave_active: "NONE",
      wave_active_reason: null,
      fast_panic_wave: "NONE",
      slow_bear: { w2: null, w3: null },
      as_of_run_at: null,
      as_of_observation_date: null,
    }
  );
}
