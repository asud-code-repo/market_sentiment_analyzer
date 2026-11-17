// Supabase reads/writes for the scenario scorecard. Pure logic lives in
// scenarioScorecard.ts.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { supabase } from "./lib/supabase.js";
import { SCENARIO_HORIZON, resolveScenarioOutcome } from "./scenarioScorecard.js";

const PRIOR_PATH = fileURLToPath(new URL("../../config/scenario_prior_v1.json", import.meta.url));
type Split = { bull: number; base: number; bear: number; crash: number };

function loadPrior(): { version: string; prior: Record<string, { split: Split }> } {
  const f = JSON.parse(readFileSync(PRIOR_PATH, "utf8"));
  return { version: `${f.name}_${f.version}`, prior: f.prior };
}

/** Add any tilt-based full report not yet on the scorecard. */
async function addNewReports(): Promise<number> {
  const { data, error } = await supabase
    .from("crash_checks")
    .select("id, run_at, sp500_as_of, hazard_10pct_as_of, sp500_level, scenario_prior_state, scenario_tilt, scenario_bull_pct, scenario_base_pct, scenario_bear_pct, scenario_crash_pct")
    .eq("scenario_method", "tilt_v1")
    .order("run_at", { ascending: true })
    .limit(5000);
  if (error) throw new Error(`scenarioScorecard: read crash_checks: ${error.message}`);
  const { version, prior } = loadPrior();
  const rows = [];
  for (const r of data ?? []) {
    const asOf = r.sp500_as_of ?? r.hazard_10pct_as_of;
    const p = prior[r.scenario_prior_state]?.split;
    if (!asOf || !p) {
      console.warn(`scenarioScorecard: skipping ${r.id} (no as-of date or unknown prior state ${r.scenario_prior_state})`);
      continue;
    }
    rows.push({
      crash_check_id: r.id,
      run_at: r.run_at,
      as_of_date: asOf,
      sp500_close: Number(r.sp500_level),
      prior_version: version,
      prior_state: r.scenario_prior_state,
      tilt: r.scenario_tilt,
      prior_bull: p.bull, prior_base: p.base, prior_bear: p.bear, prior_crash: p.crash,
      bull: r.scenario_bull_pct, base: r.scenario_base_pct, bear: r.scenario_bear_pct, crash: r.scenario_crash_pct,
    });
  }
  if (!rows.length) return 0;
  const { error: upErr } = await supabase.from("scenario_scorecard").upsert(rows, { onConflict: "crash_check_id", ignoreDuplicates: true });
  if (upErr) throw new Error(`scenarioScorecard: insert: ${upErr.message}`);
  return rows.length;
}

/** Fill in outcomes whose 63-day window has closed. */
async function resolvePending(): Promise<number> {
  const { data: pending, error } = await supabase
    .from("scenario_scorecard")
    .select("crash_check_id, as_of_date, sp500_close")
    .is("outcome_bucket", null)
    .order("as_of_date", { ascending: true });
  if (error) throw new Error(`scenarioScorecard: read pending: ${error.message}`);
  if (!pending?.length) return 0;
  const { data: closes, error: cErr } = await supabase
    .from("data_points")
    .select("observation_date, value")
    .eq("series_id", "SP500")
    .gt("observation_date", pending[0].as_of_date)
    .order("observation_date", { ascending: true })
    .limit(10000);
  if (cErr) throw new Error(`scenarioScorecard: read SP500: ${cErr.message}`);
  const series = (closes ?? []).map((c) => ({ d: c.observation_date as string, v: Number(c.value) }));
  const today = new Date().toISOString().slice(0, 10);
  let resolved = 0;
  for (const p of pending) {
    const after = series.filter((c) => c.d > p.as_of_date).map((c) => c.v);
    const o = resolveScenarioOutcome(Number(p.sp500_close), after, SCENARIO_HORIZON);
    if (!o) continue;
    const { error: uErr } = await supabase
      .from("scenario_scorecard")
      .update({ outcome_bucket: o.bucket, worst_fall_63d_pct: o.worst_fall_pct, return_63d_pct: o.return_pct, resolved_on: today, updated_at: new Date().toISOString() })
      .eq("crash_check_id", p.crash_check_id);
    if (uErr) throw new Error(`scenarioScorecard: update ${p.crash_check_id}: ${uErr.message}`);
    resolved++;
  }
  return resolved;
}

/** Called once per classify() run. Report-only and non-gating. */
export async function updateScenarioScorecard(): Promise<string> {
  const added = await addNewReports();
  const resolved = await resolvePending();
  return `scenario scorecard: ${added} report(s) checked, ${resolved} outcome(s) resolved`;
}
