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

export interface LatestSnapshotRow {
  warsh_classification: string | null;
  warsh_classification_date: string | null;
  warsh_hard_rules_active: boolean;
  fed_pivot_signal: string | null;
  trigger_status: unknown;
}

/** The most recent crash_checks row, for carrying forward manually-judged
 * fields (Warsh classification, Fed pivot signal, trigger statuses) that
 * the rule engine doesn't — and shouldn't — auto-derive. Null on first run. */
export async function getLatestCrashCheck(): Promise<LatestSnapshotRow | null> {
  const { data, error } = await supabase
    .from("crash_checks")
    .select("warsh_classification, warsh_classification_date, warsh_hard_rules_active, fed_pivot_signal, trigger_status")
    .order("run_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to read latest crash_checks row: ${error.message}`);
  }
  return data;
}

export interface CrashCheckInsert {
  sp500_level: number;
  sp500_ath: number;
  sp500_ath_date: string;
  vix_value: number;
  vix_color: "GREEN" | "AMBER" | "RED";
  hy_spread_bps: number;
  hy_spread_color: "GREEN" | "AMBER" | "RED";
  sp_drawdown_pct: number;
  sp_drawdown_color: "GREEN" | "AMBER" | "RED";
  treasury_10y_pct: number;
  treasury_10y_color: "GREEN" | "AMBER" | "RED";
  sahm_rule_value: number;
  sahm_rule_color: "GREEN" | "AMBER" | "RED";
  fed_pivot_signal: "NONE" | "PAUSE" | "CUT";
  fed_pivot_color: "GREEN" | "AMBER" | "RED";
  red_count: number;
  wave_authorized: boolean;
  wave_active: "NONE" | "WAVE_1" | "WAVE_2" | "WAVE_3";
  warsh_classification: "HAWKISH" | "MODERATE" | "DOVISH" | "PENDING" | null;
  warsh_classification_date: string | null;
  warsh_hard_rules_active: boolean;
  trigger_status: unknown;
  raw_source_data: unknown;
}

export async function insertCrashCheck(row: CrashCheckInsert): Promise<void> {
  const { error } = await supabase.from("crash_checks").insert(row);
  if (error) {
    throw new Error(`Failed to insert crash_checks row: ${error.message}`);
  }
}
