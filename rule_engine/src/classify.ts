import { getLatestDataPoint, getLatestCrashCheck, insertCrashCheck } from "./lib/supabase.js";
import {
  bandVix,
  bandHySpreadBps,
  bandSpDrawdownPct,
  bandTreasury10y,
  bandSahmRule,
  bandFedPivotSignal,
  countReds,
  isWaveAuthorized,
  activeWave,
  drawdownPct,
} from "./rules.js";

async function requireLatest(seriesId: string) {
  const point = await getLatestDataPoint(seriesId);
  if (!point) {
    throw new Error(
      `No data_points row found for required series "${seriesId}" — has the ingestion Action run yet?`,
    );
  }
  return point;
}

export async function classify(): Promise<void> {
  const [vix, hySpread, sp500, sp500Ath, treasury10y, sahmRule] = await Promise.all([
    requireLatest("VIXCLS"),
    requireLatest("BAMLH0A0HYM2"),
    requireLatest("SP500"),
    requireLatest("SP500_ATH"),
    requireLatest("DGS10"),
    requireLatest("SAHMREALTIME"),
  ]);

  const hySpreadBps = hySpread.value * 100; // FRED reports BAMLH0A0HYM2 in percent
  const drawdown = drawdownPct(sp500.value, sp500Ath.value);

  const vixColor = bandVix(vix.value);
  const hySpreadColor = bandHySpreadBps(hySpreadBps);
  const spDrawdownColor = bandSpDrawdownPct(drawdown);
  const treasury10yColor = bandTreasury10y(treasury10y.value);
  const sahmRuleColor = bandSahmRule(sahmRule.value);

  // Fed pivot signal has no clean numeric source (it's a read on Fed
  // communications) — carried forward from the last known value rather than
  // guessed. Same treatment as Warsh classification: a flagged manual/LLM
  // judgment field, not something this deterministic script decides.
  const prior = await getLatestCrashCheck();
  const fedPivotSignal = (prior?.fed_pivot_signal as "NONE" | "PAUSE" | "CUT" | null) ?? "NONE";
  if (!prior) {
    console.warn('No prior crash_checks row found — defaulting fed_pivot_signal to "NONE". Confirm/override manually on the next chat-run.');
  }
  const fedPivotColor = bandFedPivotSignal(fedPivotSignal);

  const redCount = countReds([vixColor, hySpreadColor, spDrawdownColor, treasury10yColor, sahmRuleColor, fedPivotColor]);
  const waveAuthorized = isWaveAuthorized(redCount);
  const waveActive = activeWave(sp500.value, vix.value);

  await insertCrashCheck({
    sp500_level: sp500.value,
    sp500_ath: sp500Ath.value,
    sp500_ath_date: sp500Ath.observation_date,
    vix_value: vix.value,
    vix_color: vixColor,
    hy_spread_bps: hySpreadBps,
    hy_spread_color: hySpreadColor,
    sp_drawdown_pct: drawdown,
    sp_drawdown_color: spDrawdownColor,
    treasury_10y_pct: treasury10y.value,
    treasury_10y_color: treasury10yColor,
    sahm_rule_value: sahmRule.value,
    sahm_rule_color: sahmRuleColor,
    fed_pivot_signal: fedPivotSignal,
    fed_pivot_color: fedPivotColor,
    red_count: redCount,
    wave_authorized: waveAuthorized,
    wave_active: waveActive,
    warsh_classification: (prior?.warsh_classification as "HAWKISH" | "MODERATE" | "DOVISH" | "PENDING" | null) ?? "PENDING",
    warsh_classification_date: prior?.warsh_classification_date ?? null,
    warsh_hard_rules_active: prior?.warsh_hard_rules_active ?? false,
    trigger_status: prior?.trigger_status ?? [],
    raw_source_data: {
      vix, hySpread, sp500, sp500Ath, treasury10y, sahmRule,
      note: "fed_pivot_signal and warsh_* fields carried forward from prior row — not derived here",
    },
  });

  console.log(
    `Classified: ${redCount}/6 RED (VIX=${vixColor}, HY=${hySpreadColor}, Drawdown=${spDrawdownColor}, ` +
      `10y=${treasury10yColor}, Sahm=${sahmRuleColor}, FedPivot=${fedPivotColor}). ` +
      `Wave authorized: ${waveAuthorized}. Active wave: ${waveActive}.`,
  );
}
