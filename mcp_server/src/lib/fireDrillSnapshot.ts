// Dollar-free fire-drill summary for the private Full Report (2026-11-17).
// write_full_report runs the drill through Wave 3 for the waves alone and
// for each crash-type layer, and stores only percentages, grades,
// instruments and reasons -- never the dollar amounts runFireDrill works in.
// Pure, no I/O.

import { runFireDrill, type FireDrill } from "./fireDrill.js";
import type { CrashType, Wave } from "./waveDeployment.js";
import type { Registry, ReadinessGrade, FilingEventRef } from "./instruments.js";
import type { ExchangeEntry } from "./tradeRestrictions.js";
import type { RegistryHealth } from "./deploymentInstruments.js";

export const CRASH_TYPES: CrashType[] = ["A_STAGFLATION", "B_RECESSION", "C_CREDIT", "D_AI_BUBBLE", "E_HYBRID"];

export interface DrillScenarioSummary {
  crash_type: CrashType | null; // null = the three waves alone
  pct_executable_via_primary: number;
  pct_executable_via_backup_only: number;
  pct_blocked: number;
  blocked_slots: string[];
  rerouted_by_trading_limit: string[];
}

export interface DrillLineSnapshot {
  source: Wave | CrashType;
  fund: string;
  slot: string;
  pct_of_dry_powder: number; // the policy's own share, not a dollar amount
  grade: ReadinessGrade;
  would_buy: { name: string; id: string | null; route: string; via: "primary" | "backup" } | null;
  reasons: string[];
}

export interface FireDrillSnapshot {
  through_wave: "WAVE_3";
  computed_at: string;
  scenarios: DrillScenarioSummary[];
  // Only AMBER/RED lines: the wave lines once (they're the same in every
  // scenario, since the crash layer is simulated after the waves) plus each
  // crash-type layer's own lines.
  attention_lines: DrillLineSnapshot[];
  green_line_count: number; // across the waves and every crash-type layer
  registry_review: { status: string; next_review_due: string | null };
  unreviewed_filing_events: number;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

function summarize(d: FireDrill): DrillScenarioSummary {
  const { pct_executable_via_primary, pct_executable_via_backup_only, pct_blocked, blocked_slots, rerouted_by_trading_limit } = d.summary;
  return { crash_type: d.crash_type, pct_executable_via_primary, pct_executable_via_backup_only, pct_blocked, blocked_slots, rerouted_by_trading_limit };
}

export function buildFireDrillSnapshot(
  dryPowderUsd: number,
  reg: Registry,
  health: RegistryHealth,
  today: Date,
  exchangeLog: ExchangeEntry[] = [],
  filingEvents: FilingEventRef[] = [],
): FireDrillSnapshot {
  const drill = (ct: CrashType | null) => runFireDrill("WAVE_3", ct, dryPowderUsd, reg, today, exchangeLog, false, filingEvents);
  const wavesOnly = drill(null);
  const layered = CRASH_TYPES.map(drill);

  const isWave = (s: string) => s.startsWith("WAVE_");
  const lines = [
    ...wavesOnly.lines,
    ...layered.flatMap((d) => d.lines.filter((l) => !isWave(l.source))),
  ];
  const pct = (usd: number) => (dryPowderUsd > 0 ? round1((usd / dryPowderUsd) * 100) : 0);

  return {
    through_wave: "WAVE_3",
    computed_at: today.toISOString(),
    scenarios: [summarize(wavesOnly), ...layered.map(summarize)],
    attention_lines: lines
      .filter((l) => l.grade !== "GREEN")
      .map((l) => ({ source: l.source, fund: l.fund, slot: l.slot, pct_of_dry_powder: pct(l.usd), grade: l.grade, would_buy: l.would_buy, reasons: l.reasons })),
    green_line_count: lines.filter((l) => l.grade === "GREEN").length,
    registry_review: { status: health.review.status, next_review_due: health.review.next_review_due },
    unreviewed_filing_events: health.unreviewed_filing_events ?? 0,
  };
}
