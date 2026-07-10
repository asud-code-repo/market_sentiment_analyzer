// Mirrors reference_docs/rules/crash-check-rules.md — "Wave Deployment
// Thresholds" and "Post-Crash Allocation Protocol / Stage 3". If you edit
// the percentages in that doc, mirror the change here. This is the
// deterministic half of fund-movement math — the tactical-account dollar
// amounts get computed here, not improvised by an LLM reading the doc and
// doing arithmetic in its head.
//
// Fund descriptions are deliberately generic (matching the sanitized rules
// doc), not your actual fund names — those live in local_state/portfolio.yaml.
// Claude bridges the two at chat-time only; this file stays safe to commit.

export type Wave = "WAVE_1" | "WAVE_2" | "WAVE_3";
export type CrashType = "A_STAGFLATION" | "B_RECESSION" | "C_CREDIT" | "D_AI_BUBBLE" | "E_HYBRID";

interface WaveSplit {
  fund: string;
  pct_of_wave: number;
}

interface WaveDefinition {
  pct_of_dry_powder: number;
  splits: WaveSplit[];
}

export const WAVE_DEPLOYMENT: Record<Wave, WaveDefinition> = {
  WAVE_1: {
    pct_of_dry_powder: 17.4,
    splits: [
      { fund: "Healthcare-sector defensive equity fund", pct_of_wave: 50 },
      { fund: "Real-estate/real-asset fund", pct_of_wave: 25 },
      { fund: "International equity (add to existing position)", pct_of_wave: 25 },
    ],
  },
  WAVE_2: {
    pct_of_dry_powder: 21.7,
    splits: [
      { fund: "Target-date/glide-path fund (add)", pct_of_wave: 40 },
      { fund: "International equity (add again)", pct_of_wave: 32 },
      { fund: "Energy sector ETF (brokerage window)", pct_of_wave: 16 },
      { fund: "Inflation-protected securities / TIPS (brokerage window)", pct_of_wave: 12 },
    ],
  },
  WAVE_3: {
    pct_of_dry_powder: 17.4,
    splits: [
      { fund: "US large-cap value/income fund (restore to prior weight)", pct_of_wave: 40 },
      { fund: "Target-date/glide-path fund (final add)", pct_of_wave: 35 },
      { fund: "Gold ETF (brokerage window)", pct_of_wave: 25 },
    ],
  },
};

interface CrashTypeLayerPosition {
  fund: string;
  pct_of_dry_powder: number | null; // null = "hold"/"remainder" — not a fixed deployable %
  note?: string;
}

export const CRASH_TYPE_LAYERS: Record<CrashType, CrashTypeLayerPosition[]> = {
  A_STAGFLATION: [
    { fund: "TIPS (brokerage window)", pct_of_dry_powder: 4.35 },
    { fund: "Energy sector ETF (brokerage window)", pct_of_dry_powder: 4.35 },
    { fund: "Energy single-name #1 (brokerage window)", pct_of_dry_powder: 2.61 },
    { fund: "LNG single-name (brokerage window)", pct_of_dry_powder: 2.61 },
    { fund: "Real-estate/real-asset fund", pct_of_dry_powder: 4.35 },
    { fund: "Remainder", pct_of_dry_powder: null, note: "Hold — stagflation crashes have multiple legs, don't rush" },
  ],
  B_RECESSION: [
    { fund: "Target-date/glide-path (additional)", pct_of_dry_powder: 8.7 },
    { fund: "AI/tech single-name (brokerage window, Wave 3 tranche only)", pct_of_dry_powder: 2.61 },
    { fund: "Infrastructure single-name (brokerage window)", pct_of_dry_powder: 2.61 },
    { fund: "US large-cap value/income (restore)", pct_of_dry_powder: 6.96 },
    { fund: "Stable value", pct_of_dry_powder: null, note: "Reduce to ~10% — recession crashes resolve faster, deploy aggressively" },
  ],
  C_CREDIT: [
    { fund: "Gold ETF (brokerage window)", pct_of_dry_powder: 6.96 },
    { fund: "TIPS (brokerage window)", pct_of_dry_powder: 2.61 },
    { fund: "Healthcare (additional)", pct_of_dry_powder: 4.35 },
    { fund: "Stable value", pct_of_dry_powder: null, note: "Hold large portion — credit crashes are long, deploy slowly over 6–12 months" },
  ],
  D_AI_BUBBLE: [
    { fund: "AI/tech single-name (brokerage window)", pct_of_dry_powder: 4.35 },
    { fund: "Energy single-name (brokerage window)", pct_of_dry_powder: 2.61 },
    { fund: "US large-cap value/income (restore)", pct_of_dry_powder: 6.96 },
    { fund: "Infrastructure single-name (brokerage window)", pct_of_dry_powder: 2.61 },
    { fund: "International equity (additional)", pct_of_dry_powder: 4.35 },
  ],
  E_HYBRID: [
    { fund: "TIPS (brokerage window)", pct_of_dry_powder: 4.35, note: "1st priority" },
    { fund: "Gold ETF (brokerage window)", pct_of_dry_powder: 4.35, note: "2nd priority" },
    { fund: "Healthcare (additional)", pct_of_dry_powder: 4.35, note: "3rd priority" },
    { fund: "Real-estate/real-asset fund", pct_of_dry_powder: 2.61, note: "4th priority" },
    {
      fund: "Wait for confirmed Fed pivot, then rotate into glide-path + AI/tech growth",
      pct_of_dry_powder: null,
      note: "5th priority",
    },
  ],
};

export interface DollarSplit {
  fund: string;
  usd: number | null;
  note?: string;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function computeWaveDeployment(
  wave: Wave,
  dryPowderUsd: number,
): { pct_of_dry_powder: number; total_usd: number; splits: DollarSplit[] } {
  const def = WAVE_DEPLOYMENT[wave];
  const waveUsd = (def.pct_of_dry_powder / 100) * dryPowderUsd;
  return {
    pct_of_dry_powder: def.pct_of_dry_powder,
    total_usd: round2(waveUsd),
    splits: def.splits.map((s) => ({
      fund: s.fund,
      usd: round2((s.pct_of_wave / 100) * waveUsd),
    })),
  };
}

export function computeCrashTypeLayer(crashType: CrashType, dryPowderUsd: number): DollarSplit[] {
  return CRASH_TYPE_LAYERS[crashType].map((p) => ({
    fund: p.fund,
    usd: p.pct_of_dry_powder === null ? null : round2((p.pct_of_dry_powder / 100) * dryPowderUsd),
    note: p.note,
  }));
}
