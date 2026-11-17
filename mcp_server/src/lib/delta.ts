import type { CrashCheckRow } from "./supabase.js";

const TRACKED_FIELDS = [
  "red_count",
  "confirmed_red_count",
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
  note?: string;
}

/** Only the fields that actually changed between the two most recent rows. */
export function computeDelta(latest: CrashCheckRow, prior: CrashCheckRow | undefined): FieldDelta[] {
  if (!prior) return [];
  const changes: FieldDelta[] = [];
  for (const field of TRACKED_FIELDS) {
    if (latest[field] !== prior[field]) {
      // crash_probability_pct changed meaning on 2026-11-17 (crash + 1/2 bear,
      // undefined buckets -> bear + crash over 63 trading days). Flag the
      // break instead of letting a run report it as a real move.
      const methodChanged = field === "crash_probability_pct" && (latest.scenario_method ?? null) !== (prior.scenario_method ?? null);
      changes.push({
        field,
        from: prior[field],
        to: latest[field],
        ...(methodChanged ? { note: "definition changed (now the chance of a 10%+ fall within 63 trading days, from the tilt); not comparable, don't report as a move" } : {}),
      });
    }
  }
  return changes;
}
