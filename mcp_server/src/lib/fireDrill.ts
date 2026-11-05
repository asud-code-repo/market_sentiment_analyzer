// Deployment fire drill: rehearse a wave in a calm market. Simulates the full
// plan through a given wave (ignoring wave_deployment_state — this is a
// rehearsal of the whole plan, not "what's left to do"), attaches registry
// instruments and readiness grades, and totals how much of the money could
// actually move today. Pure, no I/O; never writes state.
//
// Exchange days: each wave, then the crash-type layer, is simulated as its
// own single-transaction exchange on a separate day, all inside the current
// quarter (worst case for per-quarter trading limits — e.g. Waves 2 and 3
// both buy the target-date fund). Real exchanges already logged this quarter
// count too. One multi-fund transaction = one exchange day (TBC).

import { computeWaveDeployment, computeCrashTypeLayer, type Wave, type CrashType } from "./waveDeployment.js";
import { resolveSlot, type Registry, type ReadinessGrade, type ResolvedInstrument, type FilingEventRef } from "./instruments.js";
import { exchangeContext, type ExchangeEntry } from "./tradeRestrictions.js";

const WAVES: Wave[] = ["WAVE_1", "WAVE_2", "WAVE_3"];

export interface DrillLine {
  source: Wave | CrashType;
  fund: string;
  slot: string;
  usd: number;
  grade: ReadinessGrade;
  would_buy: { name: string; id: string | null; route: string; via: "primary" | "backup" } | null;
  reasons: string[];
}

export interface DrillTransaction {
  source: Wave | CrashType;
  simulated_exchange_day: string;
  uses_exchange_day: boolean; // false if nothing in it is bought in-plan or via BrokerageLink
  restricted_instruments_bought: string[];
}

export interface FireDrill {
  simulation: true;
  through_wave: Wave;
  crash_type: CrashType | null;
  all_plan_exchanges_count: boolean;
  transactions: DrillTransaction[];
  lines: DrillLine[];
  summary: {
    total_usd: number;
    // Shares of the simulated deployable amount, in % (hold lines excluded).
    pct_executable_via_primary: number;
    pct_executable_via_backup_only: number;
    pct_blocked: number;
    blocked_slots: string[];
    rerouted_by_trading_limit: string[];
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function idOf(inst: ResolvedInstrument): string {
  return inst.plan_name ?? inst.ticker ?? inst.name;
}

export function runFireDrill(
  throughWave: Wave,
  crashType: CrashType | null,
  dryPowderUsd: number,
  reg: Registry,
  today: Date,
  realLog: ExchangeEntry[] = [],
  allPlanExchangesCount = false,
  filingEvents: FilingEventRef[] = [],
): FireDrill {
  const groups: { source: Wave | CrashType; lines: { fund: string; slot: string | null; usd: number | null }[] }[] = [];
  for (const w of WAVES.slice(0, WAVES.indexOf(throughWave) + 1)) {
    groups.push({ source: w, lines: computeWaveDeployment(w, dryPowderUsd).splits });
  }
  if (crashType) groups.push({ source: crashType, lines: computeCrashTypeLayer(crashType, dryPowderUsd) });

  const base = { ...exchangeContext(realLog, today, allPlanExchangesCount), filingEvents };
  const simulated: ExchangeEntry[] = [];
  const lines: DrillLine[] = [];
  const transactions: DrillTransaction[] = [];
  const rerouted = new Set<string>();

  for (const g of groups) {
    const day = `sim:${g.source}`;
    const ctx = { ...base, quarterEntries: [...base.quarterEntries, ...simulated], ownDay: day };
    const bought: string[] = [];
    const restrictedBought: string[] = [];
    for (const l of g.lines) {
      if (l.slot === null || l.usd === null) continue; // hold/remainder — nothing to buy
      const res = resolveSlot(l.slot, reg, today, ctx);
      const rd = res.readiness!;
      const inst = rd.executable_via === "primary" ? res.primary : rd.executable_via === "backup" ? res.backup : null;
      if (rd.executable_via === "backup" && res.primary?.restriction?.exhausted) rerouted.add(`${g.source}:${l.slot}`);
      if (inst) {
        bought.push(inst.route === "brokeragelink" ? "BROKERAGELINK" : idOf(inst));
        if (inst.restriction?.in_force) restrictedBought.push(idOf(inst));
      }
      lines.push({
        source: g.source,
        fund: l.fund,
        slot: l.slot,
        usd: l.usd,
        grade: rd.grade,
        would_buy: inst && rd.executable_via
          ? { name: inst.name, id: inst.ticker ?? inst.plan_name ?? null, route: inst.route, via: rd.executable_via }
          : null,
        reasons: rd.reasons,
      });
    }
    // Sold side is the dry-powder holding; recorded generically since the
    // simulation only needs the bought side to count covered-fund exchanges.
    if (bought.length) simulated.push({ date: day, bought: [...new Set(bought)], sold: ["(dry powder)"] });
    transactions.push({
      source: g.source,
      simulated_exchange_day: day,
      uses_exchange_day: bought.length > 0,
      restricted_instruments_bought: [...new Set(restrictedBought)],
    });
  }

  const total = lines.reduce((a, l) => a + l.usd, 0);
  const share = (pred: (l: DrillLine) => boolean) =>
    total > 0 ? round1((lines.filter(pred).reduce((a, l) => a + l.usd, 0) / total) * 100) : 0;

  return {
    simulation: true,
    through_wave: throughWave,
    crash_type: crashType,
    all_plan_exchanges_count: allPlanExchangesCount,
    transactions,
    lines,
    summary: {
      total_usd: Math.round(total * 100) / 100,
      pct_executable_via_primary: share((l) => l.would_buy?.via === "primary"),
      pct_executable_via_backup_only: share((l) => l.would_buy?.via === "backup"),
      pct_blocked: share((l) => l.would_buy === null),
      blocked_slots: [...new Set(lines.filter((l) => l.would_buy === null).map((l) => l.slot))],
      rerouted_by_trading_limit: [...rerouted],
    },
  };
}
