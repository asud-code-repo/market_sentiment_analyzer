// ETF creation/redemption dollar flow between two dates (2026-11-20).
//
// Each day's change in shares outstanding is valued at THAT day's NAV and
// summed. The earlier method valued the whole window's share change at the
// end-of-window NAV, which overstated flow for funds whose price rose a lot
// in the window and understated it for funds that fell (GLD's 365d flow at
// its Jan 2026 peak read +50.9% of starting assets; daily valuation gives
// +34.5%). Shares only move via creation/redemption, so this is the dollar
// amount that actually went in or out.
//
// Mirrored in dashboard_site/index.html (rotFlowUsd); change both together.

export interface FlowPoint {
  date: string; // YYYY-MM-DD, ascending
  nav: number;
  shares: number; // split-adjusted; NaN where the day's shares are missing
}

/** Dollar flow from the last point on or before `fromDate` to the last point
 * on or before `toDate`. Null if there is no point on or before `fromDate`.
 * Days with missing shares are skipped; the next valid day's change covers them. */
export function flowUsdBetween(points: FlowPoint[], fromDate: string, toDate: string): number | null {
  let start = -1;
  for (let i = 0; i < points.length && points[i].date <= fromDate; i++) start = i;
  if (start < 0) return null;
  let prevShares = points[start].shares;
  let flow = 0;
  for (let i = start + 1; i < points.length && points[i].date <= toDate; i++) {
    const { shares, nav } = points[i];
    if (!Number.isFinite(shares) || !Number.isFinite(nav)) continue;
    if (Number.isFinite(prevShares)) flow += (shares - prevShares) * nav;
    prevShares = shares;
  }
  return flow;
}
