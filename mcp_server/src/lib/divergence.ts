import { computeSeriesDelta } from "./seriesDelta.js";

/**
 * Deterministic divergence detection between two normally-correlated
 * series — computed here, not left to the LLM to eyeball two raw numbers
 * and a hint (same "no LLM does numeric classification" principle as
 * everything else in this system, applied one level up: relationships
 * between indicators, not just levels). Both pairs reuse the 7-day delta
 * `get_series_deltas` already computes — divergence detection is just
 * "did these two move differently over the same window," nothing new to
 * fetch.
 *
 * Thresholds below are a first cut, not a calibrated/backtested model —
 * same spirit as the rules doc's `[new default — calibrate]` tags. Revisit
 * once there's real history of how often these actually fire.
 */
export interface DivergenceFlag {
  pair: string;
  diverging: boolean;
  detail: string;
}

export async function computeDivergences(): Promise<DivergenceFlag[]> {
  const [ig, hy, initialClaims, continuingClaims, vix] = await Promise.all([
    computeSeriesDelta("BAMLC0A0CM"),
    computeSeriesDelta("BAMLH0A0HYM2"),
    computeSeriesDelta("ICSA"),
    computeSeriesDelta("CCSA"),
    computeSeriesDelta("VIXCLS"),
  ]);

  const flags: DivergenceFlag[] = [];

  // IG spread widening (quality-flight signal) while HY isn't confirming it
  // — an earlier, quieter stress tell than waiting for the gating HY spread
  // itself to move. Thresholds: IG widened >=3bps over 7d, HY widened
  // <=1bps over the same window (i.e. HY isn't corroborating the move).
  if (ig.delta_7d !== null && hy.delta_7d !== null) {
    const diverging = ig.delta_7d >= 3 && hy.delta_7d <= 1;
    flags.push({
      pair: "ig_vs_hy_credit_spread",
      diverging,
      detail: diverging
        ? `IG spread widened ${ig.delta_7d}bps over 7d while HY only moved ${hy.delta_7d}bps — quality concern may be building ahead of the gating HY spread.`
        : `No divergence — IG (${ig.delta_7d}bps/7d) and HY (${hy.delta_7d}bps/7d) are moving together or IG isn't widening meaningfully.`,
    });
  }

  // Continuing claims climbing (people who lost jobs aren't finding new
  // ones) while initial claims stay flat (no new wave of layoffs) — a
  // quieter labor-cooling signal than initial claims alone. Thresholds:
  // continuing claims up >=15,000 over 7d, initial claims up <=5,000 over
  // the same window.
  if (initialClaims.delta_7d !== null && continuingClaims.delta_7d !== null) {
    const diverging = continuingClaims.delta_7d >= 15000 && initialClaims.delta_7d <= 5000;
    flags.push({
      pair: "initial_vs_continuing_claims",
      diverging,
      detail: diverging
        ? `Continuing claims rose ${continuingClaims.delta_7d.toLocaleString("en-US")} over 7d while initial claims moved only ${initialClaims.delta_7d.toLocaleString("en-US")} — laid-off workers may be taking longer to find new jobs.`
        : `No divergence — continuing claims (${continuingClaims.delta_7d}/7d) and initial claims (${initialClaims.delta_7d}/7d) aren't showing a meaningful split.`,
    });
  }

  // VIX (equity options market "fear") spiking without HY spreads (credit
  // market "fear") confirming — unlike the other two pairs, this
  // divergence is NOT itself an alarm signal. VIX and HY are fear proxies
  // from different markets; when only VIX moves, that reads as
  // equity-specific noise (a single stock/sector wobble, index rebalance,
  // etc.), not systemic stress broad enough to also move credit spreads.
  // Thresholds: VIX up >=3pts over 7d, HY spread up <=5bps over the same
  // window (i.e. HY isn't corroborating the move).
  if (vix.delta_7d !== null && hy.delta_7d !== null) {
    const diverging = vix.delta_7d >= 3 && hy.delta_7d <= 5;
    flags.push({
      pair: "vix_vs_hy_credit_spread",
      diverging,
      detail: diverging
        ? `VIX rose ${vix.delta_7d}pts over 7d while HY spread only moved ${hy.delta_7d}bps — reads as equity-specific noise, not confirmed systemic/credit stress. This divergence is reassuring, not alarming — do not treat it the same as the other two flags.`
        : `No meaningful VIX/HY split — VIX (${vix.delta_7d}pts/7d) and HY spread (${hy.delta_7d}bps/7d) are consistent, or VIX isn't moving enough to represent a spike.`,
    });
  }

  return flags;
}
