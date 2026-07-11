import { createClient } from "@supabase/supabase-js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

export const supabase = createClient(
  requireEnv("SUPABASE_URL"),
  requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
);

// Mirrors the crash_checks columns — see supabase/migrations/20260708000000_stage1_schema.sql
export interface CrashCheckRow {
  id: string;
  run_at: string;
  crash_probability_pct: number | null;
  crash_probability_low_pct: number | null;
  crash_probability_high_pct: number | null;
  scenario_bull_pct: number | null;
  scenario_base_pct: number | null;
  scenario_bear_pct: number | null;
  scenario_crash_pct: number | null;
  sp500_level: number;
  sp500_ath: number;
  sp500_ath_date: string;
  vix_value: number | null;
  vix_color: string | null;
  hy_spread_bps: number | null;
  hy_spread_color: string | null;
  sp_drawdown_pct: number | null;
  sp_drawdown_color: string | null;
  treasury_10y_pct: number | null;
  treasury_10y_color: string | null;
  sahm_rule_value: number | null;
  sahm_rule_color: string | null;
  fed_pivot_signal: string | null;
  fed_pivot_color: string | null;
  red_count: number;
  wave_authorized: boolean;
  wave_active: string | null;
  crash_type: string | null;
  warsh_classification: string | null;
  warsh_classification_date: string | null;
  warsh_hard_rules_active: boolean;
  trigger_status: unknown;
  notes: string | null;
  raw_source_data: unknown;
  created_at: string;
}

export interface DataPointRow {
  series_id: string;
  observation_date: string;
  value: number;
}

/** Most recent row for a series_id, or null if we've never ingested it. */
export async function getLatestDataPoint(seriesId: string): Promise<DataPointRow | null> {
  const { data, error } = await supabase
    .from("data_points")
    .select("series_id, observation_date, value")
    .eq("series_id", seriesId)
    .order("observation_date", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to read latest data_point for ${seriesId}: ${error.message}`);
  }
  return data;
}

/**
 * Full-replacement sync of the watchlist ticker *list* (symbols only) in
 * Supabase — deletes any symbol no longer present, inserts any new one.
 * Keeps ingestion's watchlist_tickers table in step with whatever
 * write_watchlist just wrote locally, in the same call, so there's no
 * separate manual step to remember. Symbols alone aren't personal data —
 * see supabase/migrations/20260711000000_watchlist_tickers.sql.
 */
export async function syncWatchlistTickers(symbols: string[]): Promise<void> {
  const { data: existing, error: readError } = await supabase.from("watchlist_tickers").select("symbol");
  if (readError) {
    throw new Error(`Failed to read watchlist_tickers: ${readError.message}`);
  }

  const existingSymbols = new Set((existing ?? []).map((row) => row.symbol as string));
  const desiredSymbols = new Set(symbols);

  const toInsert = symbols.filter((s) => !existingSymbols.has(s));
  const toDelete = [...existingSymbols].filter((s) => !desiredSymbols.has(s));

  if (toInsert.length > 0) {
    const { error } = await supabase.from("watchlist_tickers").insert(toInsert.map((symbol) => ({ symbol })));
    if (error) throw new Error(`Failed to insert into watchlist_tickers: ${error.message}`);
  }
  if (toDelete.length > 0) {
    const { error } = await supabase.from("watchlist_tickers").delete().in("symbol", toDelete);
    if (error) throw new Error(`Failed to delete from watchlist_tickers: ${error.message}`);
  }
}

/** Most recent rows, newest first. `limit=2` is enough for a delta calc. */
export async function getRecentCrashChecks(limit: number): Promise<CrashCheckRow[]> {
  const { data, error } = await supabase
    .from("crash_checks")
    .select("*")
    .order("run_at", { ascending: false })
    .limit(limit);

  if (error) {
    throw new Error(`Failed to read crash_checks: ${error.message}`);
  }
  return data ?? [];
}

/**
 * Inserts a new crash_checks row combining the latest row's mechanical
 * fields (indicator panel, wave status, S&P level/ATH — read fresh here,
 * not trusted from caller input) with the qualitative fields Claude
 * supplies. Throws if no prior row exists — the rule engine (Stage 3) must
 * run at least once before a chat-side write_snapshot call is possible.
 */
export async function writeSnapshot(qualitative: {
  crash_probability_pct: number;
  crash_probability_low_pct: number;
  crash_probability_high_pct: number;
  scenario_bull_pct: number;
  scenario_base_pct: number;
  scenario_bear_pct: number;
  scenario_crash_pct: number;
  notes: string;
  crash_type?: string | null;
  warsh_classification?: string | null;
  warsh_classification_date?: string | null;
  warsh_hard_rules_active?: boolean;
  fed_pivot_signal?: "NONE" | "PAUSE" | "CUT";
  trigger_status?: unknown;
}): Promise<CrashCheckRow> {
  const [latest] = await getRecentCrashChecks(1);
  if (!latest) {
    throw new Error("No prior crash_checks row found — the rule engine (Stage 3) must run at least once first.");
  }

  const fedPivotSignal = qualitative.fed_pivot_signal ?? (latest.fed_pivot_signal as "NONE" | "PAUSE" | "CUT" | null) ?? "NONE";
  const fedPivotColor = fedPivotSignal === "NONE" ? "GREEN" : fedPivotSignal === "PAUSE" ? "AMBER" : "RED";

  const row = {
    // Mechanical fields carried forward from the latest rule-engine row —
    // Claude reports on these, it doesn't recompute or override them
    // (except fed_pivot_signal, the one manually-judged indicator).
    sp500_level: latest.sp500_level,
    sp500_ath: latest.sp500_ath,
    sp500_ath_date: latest.sp500_ath_date,
    vix_value: latest.vix_value,
    vix_color: latest.vix_color,
    hy_spread_bps: latest.hy_spread_bps,
    hy_spread_color: latest.hy_spread_color,
    sp_drawdown_pct: latest.sp_drawdown_pct,
    sp_drawdown_color: latest.sp_drawdown_color,
    treasury_10y_pct: latest.treasury_10y_pct,
    treasury_10y_color: latest.treasury_10y_color,
    sahm_rule_value: latest.sahm_rule_value,
    sahm_rule_color: latest.sahm_rule_color,
    fed_pivot_signal: fedPivotSignal,
    fed_pivot_color: fedPivotColor,
    red_count: latest.red_count,
    wave_authorized: latest.wave_authorized,
    wave_active: latest.wave_active,

    // Qualitative fields from Claude's synthesis this run.
    crash_probability_pct: qualitative.crash_probability_pct,
    crash_probability_low_pct: qualitative.crash_probability_low_pct,
    crash_probability_high_pct: qualitative.crash_probability_high_pct,
    scenario_bull_pct: qualitative.scenario_bull_pct,
    scenario_base_pct: qualitative.scenario_base_pct,
    scenario_bear_pct: qualitative.scenario_bear_pct,
    scenario_crash_pct: qualitative.scenario_crash_pct,
    notes: qualitative.notes,
    crash_type: qualitative.crash_type ?? latest.crash_type,
    warsh_classification: qualitative.warsh_classification ?? latest.warsh_classification,
    warsh_classification_date: qualitative.warsh_classification_date ?? latest.warsh_classification_date,
    warsh_hard_rules_active: qualitative.warsh_hard_rules_active ?? latest.warsh_hard_rules_active,
    trigger_status: qualitative.trigger_status ?? latest.trigger_status,
    raw_source_data: { copied_from_crash_check_id: latest.id },
  };

  const { data, error } = await supabase.from("crash_checks").insert(row).select().single();
  if (error) {
    throw new Error(`Failed to insert crash_checks row: ${error.message}`);
  }
  return data;
}
