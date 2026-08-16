import { computeSeriesDelta7d } from "./lib/seriesDelta.js";

/**
 * Deterministic divergence detection between two normally-correlated
 * series — computed here, in the rule engine, not left to the LLM to
 * eyeball two raw numbers (same "no LLM does numeric classification"
 * principle applied to relationships between indicators, not just
 * levels). Runs once daily inside classify(), persisted to
 * crash_checks.divergence_flags — this is the single source of truth;
 * mcp_server's get_context_indicators reads it rather than recomputing,
 * so the chat narrative and dashboard_site are always looking at
 * identical values. Includes each side's own value/delta so any consumer
 * can render a full "badge + both series" display without needing its
 * own computation.
 *
 * Thresholds are a first cut, not calibrated/backtested — same spirit as
 * the rules doc's `[new default — calibrate]` tags.
 */
export interface DivergenceSeriesInfo {
  label: string;
  value: number;
  unit: string;
  delta_7d: number | null;
}

export interface DivergenceFlag {
  pair: string;
  diverging: boolean;
  detail: string;
  series_a: DivergenceSeriesInfo;
  series_b: DivergenceSeriesInfo;
}

export async function computeDivergences(): Promise<DivergenceFlag[]> {
  const [ig, hy, initialClaims, continuingClaims, vix] = await Promise.all([
    computeSeriesDelta7d("BAMLC0A0CM"),
    computeSeriesDelta7d("BAMLH0A0HYM2"),
    computeSeriesDelta7d("ICSA"),
    computeSeriesDelta7d("CCSA"),
    computeSeriesDelta7d("VIXCLS"),
  ]);

  const flags: DivergenceFlag[] = [];

  if (ig.value !== null && ig.delta_7d !== null && hy.value !== null && hy.delta_7d !== null) {
    const diverging = ig.delta_7d >= 3 && hy.delta_7d <= 1;
    flags.push({
      pair: "ig_vs_hy_credit_spread",
      diverging,
      detail: diverging
        ? `IG spread widened ${ig.delta_7d}bps over 7d while HY only moved ${hy.delta_7d}bps — quality concern may be building ahead of the gating HY spread.`
        : `No divergence — IG (${ig.delta_7d}bps/7d) and HY (${hy.delta_7d}bps/7d) are moving together or IG isn't widening meaningfully.`,
      series_a: { label: "IG Credit Spread", value: ig.value, unit: "bps", delta_7d: ig.delta_7d },
      series_b: { label: "HY Credit Spread", value: hy.value, unit: "bps", delta_7d: hy.delta_7d },
    });
  }

  if (
    initialClaims.value !== null &&
    initialClaims.delta_7d !== null &&
    continuingClaims.value !== null &&
    continuingClaims.delta_7d !== null
  ) {
    const diverging = continuingClaims.delta_7d >= 15000 && initialClaims.delta_7d <= 5000;
    flags.push({
      pair: "initial_vs_continuing_claims",
      diverging,
      detail: diverging
        ? `Continuing claims rose ${continuingClaims.delta_7d.toLocaleString("en-US")} over 7d while initial claims moved only ${initialClaims.delta_7d.toLocaleString("en-US")} — laid-off workers may be taking longer to find new jobs.`
        : `No divergence — continuing claims (${continuingClaims.delta_7d}/7d) and initial claims (${initialClaims.delta_7d}/7d) aren't showing a meaningful split.`,
      series_a: { label: "Initial Jobless Claims", value: initialClaims.value, unit: "count", delta_7d: initialClaims.delta_7d },
      series_b: { label: "Continuing Jobless Claims", value: continuingClaims.value, unit: "count", delta_7d: continuingClaims.delta_7d },
    });
  }

  // VIX-vs-HY is the one pair where diverging:true is the REASSURING case,
  // not the concerning one (see detail text) — consumers must not treat
  // "diverging" as uniformly bad across all three flags.
  if (vix.value !== null && vix.delta_7d !== null && hy.value !== null && hy.delta_7d !== null) {
    const diverging = vix.delta_7d >= 3 && hy.delta_7d <= 5;
    flags.push({
      pair: "vix_vs_hy_credit_spread",
      diverging,
      detail: diverging
        ? `VIX rose ${vix.delta_7d}pts over 7d while HY spread only moved ${hy.delta_7d}bps — reads as equity-specific noise, not confirmed systemic/credit stress. This divergence is reassuring, not alarming.`
        : `No meaningful VIX/HY split — VIX (${vix.delta_7d}pts/7d) and HY spread (${hy.delta_7d}bps/7d) are consistent, or VIX isn't moving enough to represent a spike.`,
      series_a: { label: "VIX", value: vix.value, unit: "index", delta_7d: vix.delta_7d },
      series_b: { label: "HY Credit Spread", value: hy.value, unit: "bps", delta_7d: hy.delta_7d },
    });
  }

  // The reverse direction of vix_vs_hy_credit_spread above, added 2026-08-16
  // — credit stress showing up before equity vol does is the more
  // concerning direction (credit often leads equity), previously missing.
  // Thresholds deliberately reuse that sibling pair's own two constants
  // (5bps, 3pts) flipped, rather than inventing new unbacktested numbers:
  // its "calm HY" ceiling (<=5bps) becomes this pair's "big HY move" floor;
  // its "big VIX move" floor (>=3pts) becomes this pair's "calm VIX"
  // ceiling. diverging:true here IS the concerning case (matches
  // ig_vs_hy_credit_spread/initial_vs_continuing_claims's convention,
  // unlike vix_vs_hy_credit_spread above).
  if (hy.value !== null && hy.delta_7d !== null && vix.value !== null && vix.delta_7d !== null) {
    const diverging = hy.delta_7d >= 5 && vix.delta_7d <= 3;
    flags.push({
      pair: "hy_widening_vix_calm",
      diverging,
      detail: diverging
        ? `HY spread widened ${hy.delta_7d}bps over 7d while VIX only moved ${vix.delta_7d}pts — credit stress may be building before equity markets notice.`
        : `No divergence — HY spread (${hy.delta_7d}bps/7d) and VIX (${vix.delta_7d}pts/7d) aren't showing a meaningful split, or HY isn't widening enough to represent stress.`,
      series_a: { label: "HY Credit Spread", value: hy.value, unit: "bps", delta_7d: hy.delta_7d },
      series_b: { label: "VIX", value: vix.value, unit: "index", delta_7d: vix.delta_7d },
    });
  }

  return flags;
}
