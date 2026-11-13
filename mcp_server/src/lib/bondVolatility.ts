// MOVE index level bands (E2, 2026-11-13; crash-check-rules.md "Bond
// volatility (MOVE)"). Context only: never feeds red_count,
// confirmed_red_count or wave logic.
//
// PROVISIONAL, not backtested against outcomes. Base rate on Yahoo's
// 2002-11-12..2026-11-12 daily closes: above 130 on 8.2% of days, above
// 160 on 2.5%, concentrated in 2008-09 and 2022-23.
export const MOVE_ELEVATED_ABOVE = 130;
export const MOVE_STRESS_ABOVE = 160;

export type MoveLevel = "normal" | "elevated" | "stress";

export function classifyMoveLevel(value: number): MoveLevel {
  if (value > MOVE_STRESS_ABOVE) return "stress";
  if (value > MOVE_ELEVATED_ABOVE) return "elevated";
  return "normal";
}
