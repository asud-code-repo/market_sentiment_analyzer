import type { CrashCheckRow } from "./supabase.js";

const TRACKED_FIELDS = [
  "red_count",
  "confirmed_red_count",
  "wave_active",
  "wave_authorized",
  "sp500_level",
  "sp_drawdown_pct",
  "vix_value",
  "vix_color",
  "hy_spread_bps",
  "hy_spread_color",
  "treasury_10y_pct",
  "treasury_10y_color",
  "sahm_rule_value",
  "sahm_rule_color",
  "fed_pivot_signal",
  "warsh_classification",
  "crash_probability_pct",
] as const satisfies readonly (keyof CrashCheckRow)[];

export interface FieldDelta {
  field: string;
  from: unknown;
  to: unknown;
}

/** Only the fields that actually changed between the two most recent rows. */
export function computeDelta(latest: CrashCheckRow, prior: CrashCheckRow | undefined): FieldDelta[] {
  if (!prior) return [];
  const changes: FieldDelta[] = [];
  for (const field of TRACKED_FIELDS) {
    if (latest[field] !== prior[field]) {
      changes.push({ field, from: prior[field], to: latest[field] });
    }
  }
  return changes;
}
