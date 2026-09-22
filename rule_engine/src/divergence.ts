import { computeSeriesDelta7d, getValueOnOrBefore, subtractDays } from "./lib/seriesDelta.js";
import { getLatestDataPoint } from "./lib/supabase.js";

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
  const [ig, hy, initialClaims, continuingClaims, vix, gold, silver] = await Promise.all([
    computeSeriesDelta7d("BAMLC0A0CM"),
    computeSeriesDelta7d("BAMLH0A0HYM2"),
    computeSeriesDelta7d("ICSA"),
    computeSeriesDelta7d("CCSA"),
    computeSeriesDelta7d("VIXCLS"),
    computeSeriesDelta7d("GLD"),
    computeSeriesDelta7d("SLV"),
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

  // Gold vs. silver, added 2026-09-22. Unlike the pairs above (bps/pts
  // deltas directly comparable within a pair), gold's and silver's price
  // levels differ too much for a raw $ delta to mean anything side by
  // side, so this pair compares 7-day PERCENT change instead. Silver
  // normally has meaningfully higher beta than gold (smaller/thinner
  // market, larger industrial-demand component) — gold outperforming
  // silver by a wide margin over 7 days is the classic flight-to-safety
  // read: investors favoring the purer monetary/store-of-value metal over
  // the more industrially/growth-linked one. This is a delta-based read on
  // short-term relative performance, not an absolute gold/silver RATIO
  // level analysis (the more commonly-cited version of this signal, which
  // would need historical percentile bands this system doesn't compute
  // yet) — same "first cut, not backtested" caveat as every threshold
  // above. Silver (SLV) is tracked only as this pair's input, deliberately
  // not exposed as its own standalone contextual indicator (see massive.ts)
  // — it has no tied decision the way gold's Type C/E sleeve allocation
  // does, so a bare price line would just be noise.
  if (gold.value !== null && gold.delta_7d !== null && silver.value !== null && silver.delta_7d !== null) {
    const goldPast = gold.value - gold.delta_7d;
    const silverPast = silver.value - silver.delta_7d;
    const goldPct7d = goldPast !== 0 ? Math.round(((gold.delta_7d / goldPast) * 100) * 10) / 10 : null;
    const silverPct7d = silverPast !== 0 ? Math.round(((silver.delta_7d / silverPast) * 100) * 10) / 10 : null;
    if (goldPct7d !== null && silverPct7d !== null) {
      const spread = Math.round((goldPct7d - silverPct7d) * 10) / 10;
      const diverging = spread >= 3;
      flags.push({
        pair: "gold_vs_silver",
        diverging,
        detail: diverging
          ? `Gold moved ${goldPct7d}% over 7d vs. silver's ${silverPct7d}% — a ${spread}pt gap. Silver normally has higher beta than gold; gold outperforming by this much is a classic flight-to-safety read (favoring the purer monetary metal over the more industrially-linked one), not proof of anything on its own.`
          : `No meaningful gold/silver split — gold (${goldPct7d}%/7d) and silver (${silverPct7d}%/7d) are moving together or silver isn't lagging enough to represent a flight-to-safety divergence.`,
        series_a: { label: "Gold (GLD)", value: gold.value, unit: "usd", delta_7d: gold.delta_7d },
        series_b: { label: "Silver (SLV)", value: silver.value, unit: "usd", delta_7d: silver.delta_7d },
      });
    }
  }

  // Foreign official Treasury holdings vs. 10yr yield, added 2026-09-22 —
  // the "who's still buying the bonds" question from the fiscal-dominance
  // discussion. UNLIKE every pair above, this uses a 90-CALENDAR-DAY
  // window, not 7 (the `delta_7d` field name is reused for schema
  // consistency across every pair, but holds a 90-day delta here — see
  // this pair's own detail text, which always states the window
  // explicitly): TIC_FOREIGN_OFFICIAL_HOLDINGS is monthly with a ~2-month
  // publication lag, so a 7-day window would show zero movement almost
  // every single day regardless of the real trend. Both series are
  // anchored to TIC's own latest (lagged) observation date, not "today" --
  // comparing DGS10's real-time move against TIC's stale reading would
  // silently compare two different time windows and produce a meaningless
  // number. Foreign *official* (not total) holdings specifically, since
  // official-sector selling (central banks/governments) is the genuine
  // fiscal-stress signal — private investor reallocation is a different,
  // much noisier thing.
  const ticOfficialLatest = await getLatestDataPoint("TIC_FOREIGN_OFFICIAL_HOLDINGS");
  if (ticOfficialLatest) {
    const anchorDate = ticOfficialLatest.observation_date;
    const pastDate = subtractDays(anchorDate, 90);
    const [ticPast, dgs10AtAnchor, dgs10Past] = await Promise.all([
      getValueOnOrBefore("TIC_FOREIGN_OFFICIAL_HOLDINGS", pastDate),
      getValueOnOrBefore("DGS10", anchorDate),
      getValueOnOrBefore("DGS10", pastDate),
    ]);
    if (ticPast !== null && dgs10AtAnchor !== null && dgs10Past !== null) {
      const ticDelta90d = Math.round((ticOfficialLatest.value - ticPast) * 10) / 10;
      const dgs10Delta90d = Math.round((dgs10AtAnchor - dgs10Past) * 100) / 100;
      const diverging = ticDelta90d <= -50 && dgs10Delta90d >= 0.15;
      flags.push({
        pair: "foreign_official_holdings_vs_10y_yield",
        diverging,
        detail: diverging
          ? `Foreign official Treasury holdings fell $${Math.abs(ticDelta90d)}B over the 90 days ending ${anchorDate} while the 10yr yield rose ${dgs10Delta90d}pts over that same window — official-sector selling alongside rising yields is the "who's still buying the bonds" fiscal-stress signal, not proof of a debt crisis on its own (one 90-day window, first cut, not backtested).`
          : `No meaningful divergence — foreign official holdings (${ticDelta90d >= 0 ? "+" : ""}$${ticDelta90d}B/90d) and the 10yr yield (${dgs10Delta90d >= 0 ? "+" : ""}${dgs10Delta90d}pts/90d) aren't showing the "official selling + rising yields" pattern over the window ending ${anchorDate}.`,
        series_a: { label: "Foreign Official Treasury Holdings", value: ticOfficialLatest.value, unit: "usd_billions", delta_7d: ticDelta90d },
        series_b: { label: "10yr Treasury Yield", value: dgs10AtAnchor, unit: "percent", delta_7d: dgs10Delta90d },
      });
    }
  }

  return flags;
}
