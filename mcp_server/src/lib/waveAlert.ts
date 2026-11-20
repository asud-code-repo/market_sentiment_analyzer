// Wave-trigger push alert (replaces the old "2 confirmed RED" alert, 2026-11-19).
//
// Why: a backtest (market-hazard-model experiments/a1_push_alert) found the
// 2-RED alert never fired before the 10% point in the four bear markets since
// 1990 and was followed by a 10% fall less often than an ordinary day. Since
// the stress gate became information only, a wave trigger alone makes a wave
// deployable, so the moment worth a push is the trigger itself.
//
// Wave triggers are personal policy (local_state/policy.yaml), so this runs
// locally (src/scripts/waveAlert.ts via Task Scheduler), never in GitHub Actions.

export type WaveLevel = "NONE" | "WAVE_1" | "WAVE_2" | "WAVE_3";

const RANK: Record<WaveLevel, number> = { NONE: 0, WAVE_1: 1, WAVE_2: 2, WAVE_3: 3 };

/** Distinct observation dates with no wave before the alert re-arms. */
export const QUIET_DATES_TO_REARM = 10;

export interface WaveAlertState {
  last_alerted_level: WaveLevel;
  quiet_dates: string[]; // distinct observation dates with no wave since the last activity
  last_alert_date: string | null;
}

export const INITIAL_STATE: WaveAlertState = { last_alerted_level: "NONE", quiet_dates: [], last_alert_date: null };

/**
 * Notify when the wave level rises above the last alerted level. A dip and a
 * return to the same or a lower level stays quiet. After QUIET_DATES_TO_REARM
 * distinct observation dates with no wave, the alert re-arms.
 */
export function decideWaveAlert(
  state: WaveAlertState,
  wave: WaveLevel,
  observationDate: string | null,
): { notify: boolean; next: WaveAlertState } {
  if (!observationDate) return { notify: false, next: state };
  if (RANK[wave] > RANK[state.last_alerted_level]) {
    return { notify: true, next: { last_alerted_level: wave, quiet_dates: [], last_alert_date: observationDate } };
  }
  if (wave === "NONE") {
    const quiet = state.quiet_dates.includes(observationDate) ? state.quiet_dates : [...state.quiet_dates, observationDate];
    if (state.last_alerted_level !== "NONE" && quiet.length >= QUIET_DATES_TO_REARM) {
      return { notify: false, next: { ...state, last_alerted_level: "NONE", quiet_dates: [] } };
    }
    return { notify: false, next: { ...state, quiet_dates: state.last_alerted_level === "NONE" ? [] : quiet } };
  }
  return { notify: false, next: { ...state, quiet_dates: [] } };
}

const NAME: Record<WaveLevel, string> = { NONE: "No wave", WAVE_1: "Wave 1", WAVE_2: "Wave 2", WAVE_3: "Wave 3" };

/** Push text: no dollar figures, no trigger levels. */
export function waveAlertMessage(
  wave: WaveLevel,
  reason: string | null,
  stressGateMet: boolean | null,
  confirmedReds: number | null,
): { title: string; body: string } {
  const how = reason === "SLOW_BEAR" ? " (slow bear)" : reason === "FAST_PANIC" ? " (fast panic)" : "";
  const gate =
    stressGateMet == null ? "" : ` Stress gate ${stressGateMet ? "met" : "not met"}${confirmedReds != null ? ` (${confirmedReds} of 6 confirmed RED)` : ""}, information only.`;
  return {
    title: `${NAME[wave]} trigger hit`,
    body: `${NAME[wave]} trigger hit${how}.${gate} Check get_deployment_plan or the Full Report before trading; one wave per week.`,
  };
}
