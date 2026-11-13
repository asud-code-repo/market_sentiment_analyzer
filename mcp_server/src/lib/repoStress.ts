// Funding-pressure flag on the SOFR - IORB repo-stress spread (E1,
// 2026-11-13; crash-check-rules.md "Repo-stress spread (SOFR minus IORB)").
// Context only: never feeds red_count, confirmed_red_count or wave logic.
//
// PROVISIONAL threshold, chosen from the backfilled base rate rather than
// backtested against outcomes: > +5bp on 3+ consecutive SOFR observations
// fired on 3.1% of days 2018-04-03..2026-11-12 (2019 repo stress and
// Oct-Dec 2025 only). The spec's original "> 0bp" fired on 12.5% of days,
// including long ordinary stretches, so it was rejected.
//
// "Consecutive business days" = consecutive stored observations. SOFR
// publishes only on business days, so this is what the base rate counted.
export const FUNDING_PRESSURE_THRESHOLD_BPS = 5;
export const FUNDING_PRESSURE_MIN_CONSECUTIVE_DAYS = 3;

export interface SpreadObservation {
  observation_date: string;
  value: number;
}

export interface FundingPressureFlag {
  /** null when fewer than MIN_CONSECUTIVE_DAYS observations exist — unknown, not false. */
  flag: boolean | null;
  provisional: true;
  threshold: string;
  /** Run length of consecutive observations above the threshold, ending at the latest one. */
  consecutive_days_above: number | null;
  /** First date of the current above-threshold run, or null if not above today. */
  above_since: string | null;
}

export function computeFundingPressureFlag(observations: SpreadObservation[]): FundingPressureFlag {
  const threshold = `> +${FUNDING_PRESSURE_THRESHOLD_BPS}bp on ${FUNDING_PRESSURE_MIN_CONSECUTIVE_DAYS}+ consecutive business days (provisional)`;
  const newestFirst = [...observations].sort((a, b) => b.observation_date.localeCompare(a.observation_date));
  if (newestFirst.length < FUNDING_PRESSURE_MIN_CONSECUTIVE_DAYS) {
    return { flag: null, provisional: true, threshold, consecutive_days_above: null, above_since: null };
  }
  let run = 0;
  while (run < newestFirst.length && newestFirst[run].value > FUNDING_PRESSURE_THRESHOLD_BPS) run++;
  return {
    flag: run >= FUNDING_PRESSURE_MIN_CONSECUTIVE_DAYS,
    provisional: true,
    threshold,
    consecutive_days_above: run,
    above_since: run > 0 ? newestFirst[run - 1].observation_date : null,
  };
}
