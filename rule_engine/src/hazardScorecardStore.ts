// Supabase reads/writes for the hazard scorecard. Pure logic (baseline,
// bands, outcome resolution) lives in hazardScorecard.ts so it can be tested
// without credentials.

import { supabase } from "./lib/supabase.js";
import type { HazardBand } from "./hazardModel.js";
import { MODEL_VERSION, BASELINE_VERSION, HORIZONS, baselineScore, bandBaseline, resolveOutcome } from "./hazardScorecard.js";

export interface ScorecardDay {
  as_of_date: string;
  model_band: HazardBand | null;
  model_raw_pct: number | null;
  sp500_level: number;
  sp500_ath: number;
  drawdown_pct: number;
  vix: number;
  inputs?: Record<string, number> | null;
}

function toRow(d: ScorecardDay) {
  const score = baselineScore(d.drawdown_pct, d.vix);
  return {
    as_of_date: d.as_of_date,
    model_version: MODEL_VERSION,
    model_band: d.model_band,
    model_raw_pct: d.model_raw_pct,
    baseline_version: BASELINE_VERSION,
    baseline_score: Math.round(score * 100) / 100,
    baseline_band: bandBaseline(score),
    sp500_level: d.sp500_level,
    sp500_ath: d.sp500_ath,
    drawdown_pct: Math.round(d.drawdown_pct * 100) / 100,
    vix: d.vix,
    inputs: d.inputs ?? null,
  };
}

/** Earlier eligible crash_checks days not yet on the scorecard (latest run per as-of date). */
async function backfillFromCrashChecks(): Promise<number> {
  const { data, error } = await supabase
    .from("crash_checks")
    .select("run_at, hazard_10pct_as_of, hazard_10pct_band, hazard_10pct_raw_pct, sp500_level, sp500_ath, sp_drawdown_pct, vix_value")
    .not("hazard_10pct_as_of", "is", null)
    .not("hazard_10pct_band", "is", null)
    .order("run_at", { ascending: true })
    .limit(5000);
  if (error) throw new Error(`hazardScorecard: read crash_checks: ${error.message}`);
  const byDate = new Map<string, ScorecardDay>();
  for (const r of data ?? []) {
    byDate.set(r.hazard_10pct_as_of, {
      as_of_date: r.hazard_10pct_as_of,
      model_band: r.hazard_10pct_band,
      model_raw_pct: r.hazard_10pct_raw_pct === null ? null : Number(r.hazard_10pct_raw_pct),
      sp500_level: Number(r.sp500_level),
      sp500_ath: Number(r.sp500_ath),
      drawdown_pct: Number(r.sp_drawdown_pct),
      vix: Number(r.vix_value),
    });
  }
  const rows = [...byDate.values()].map(toRow);
  if (!rows.length) return 0;
  const { error: upErr } = await supabase
    .from("hazard_scorecard")
    .upsert(rows, { onConflict: "as_of_date", ignoreDuplicates: true });
  if (upErr) throw new Error(`hazardScorecard: backfill: ${upErr.message}`);
  return rows.length;
}

/** Fill in outcomes for rows whose window has now closed. Returns how many were resolved. */
async function resolvePending(): Promise<number> {
  const { data: pending, error } = await supabase
    .from("hazard_scorecard")
    .select("as_of_date, sp500_ath, outcome_21d, outcome_63d")
    .or("outcome_21d.is.null,outcome_63d.is.null")
    .order("as_of_date", { ascending: true });
  if (error) throw new Error(`hazardScorecard: read pending: ${error.message}`);
  if (!pending?.length) return 0;

  const { data: closes, error: cErr } = await supabase
    .from("data_points")
    .select("observation_date, value")
    .eq("series_id", "SP500")
    .gt("observation_date", pending[0].as_of_date)
    .order("observation_date", { ascending: true })
    .limit(10000);
  if (cErr) throw new Error(`hazardScorecard: read SP500: ${cErr.message}`);
  const series = (closes ?? []).map((c) => ({ d: c.observation_date as string, v: Number(c.value) }));

  const today = new Date().toISOString().slice(0, 10);
  let resolved = 0;
  for (const p of pending) {
    const after = series.filter((c) => c.d > p.as_of_date).map((c) => c.v);
    const update: Record<string, unknown> = {};
    for (const h of HORIZONS) {
      if (p[`outcome_${h}d` as "outcome_21d"] !== null) continue;
      const o = resolveOutcome(Number(p.sp500_ath), after, h);
      if (!o) continue;
      update[`outcome_${h}d`] = o.hit;
      update[`max_drawdown_${h}d_pct`] = o.max_drawdown_pct;
      update[`resolved_${h}d_on`] = today;
    }
    if (!Object.keys(update).length) continue;
    update.updated_at = new Date().toISOString();
    const { error: uErr } = await supabase.from("hazard_scorecard").update(update).eq("as_of_date", p.as_of_date);
    if (uErr) throw new Error(`hazardScorecard: update ${p.as_of_date}: ${uErr.message}`);
    resolved++;
  }
  return resolved;
}

/**
 * Called once per classify() run, after the crash_checks insert. Records
 * today's scored day (overwriting an earlier run for the same as-of date,
 * with the full input snapshot), backfills any earlier eligible days, and
 * resolves windows that have closed.
 */
export async function updateHazardScorecard(today: ScorecardDay | null): Promise<string> {
  const backfilled = await backfillFromCrashChecks();
  if (today) {
    const { error } = await supabase
      .from("hazard_scorecard")
      .upsert({ ...toRow(today), updated_at: new Date().toISOString() }, { onConflict: "as_of_date" });
    if (error) throw new Error(`hazardScorecard: upsert today: ${error.message}`);
  }
  const resolved = await resolvePending();
  return `scorecard: ${backfilled} day(s) checked for backfill, ${resolved} outcome row(s) resolved`;
}
