import { supabase } from "./supabase.js";

// Sector-rotation panel: 11 Select Sector SPDRs + SPY + GLD, sourced from
// State Street's own free NAV-history files (ingestion/src/sources/ssga.ts)
// -- deliberately not TLT/DBC, which are iShares/Invesco and have no
// confirmed SSGA-equivalent free source. This is ETF-vehicle-level flow
// (shares outstanding only moves via real creation/redemption), not a
// complete picture of money entering/leaving the underlying sector --
// investors can get the same exposure through other ETFs (QQQ/VGT/SMH for
// tech, say). See crash-check-rules.md's Contextual Indicators section.
export const SECTOR_TICKERS: { ticker: string; label: string }[] = [
  { ticker: "XLK", label: "Technology" },
  { ticker: "XLF", label: "Financials" },
  { ticker: "XLE", label: "Energy" },
  { ticker: "XLV", label: "Health Care" },
  { ticker: "XLI", label: "Industrials" },
  { ticker: "XLY", label: "Consumer Discretionary" },
  { ticker: "XLP", label: "Consumer Staples" },
  { ticker: "XLU", label: "Utilities" },
  { ticker: "XLB", label: "Materials" },
  { ticker: "XLRE", label: "Real Estate" },
  { ticker: "XLC", label: "Communication Services" },
  { ticker: "SPY", label: "S&P 500" },
  { ticker: "GLD", label: "Gold" },
];

const LOOKBACK_WINDOWS_DAYS = [30, 90, 180, 365] as const;
type LookbackWindow = (typeof LOOKBACK_WINDOWS_DAYS)[number];

// Confirmed-vs-divergent read, from the same "return alone is just price
// noise, flow alone misses whether the market agrees" reasoning that
// motivated finding a real flow source in the first place (see this
// module's own doc comment). Computed per window from the same
// nav_return_pct/flow_estimate_usd values below -- not a new data source,
// just naming the quadrant so a narrative-synthesis consumer (or a UI)
// doesn't have to cross-reference two separate fields to see it.
export type RotationRead = "confirmed_in" | "confirmed_out" | "accumulation_divergence" | "distribution_divergence";

export interface TickerRotation {
  symbol: string;
  label: string;
  as_of: string | null;
  nav_return_pct: Partial<Record<`${LookbackWindow}d`, number>>;
  flow_estimate_usd: Partial<Record<`${LookbackWindow}d`, number>>;
  rotation_read: Partial<Record<`${LookbackWindow}d`, RotationRead>>;
}

function classifyRotation(navReturnPct: number, flowUsd: number): RotationRead {
  if (navReturnPct >= 0 && flowUsd >= 0) return "confirmed_in";
  if (navReturnPct < 0 && flowUsd < 0) return "confirmed_out";
  if (navReturnPct < 0 && flowUsd >= 0) return "accumulation_divergence"; // price down, real money arriving
  return "distribution_divergence"; // price up, real money leaving
}

interface SeriesPoint {
  date: string;
  value: number;
}

function subtractDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

// Most recent point on or before the given date, searching a pre-fetched
// series ascending by date (binary-search-free linear scan -- these series
// are at most ~1,260 points each at the 5yr backfill depth, cheap enough
// not to warrant a real binary search). Same "on or before, not exact
// match" approximation as mcp_server/src/lib/seriesDelta.ts's
// getValueOnOrBefore, for the same reason (markets don't publish every
// calendar day).
function valueOnOrBefore(series: SeriesPoint[], onOrBeforeDate: string): number | null {
  let result: number | null = null;
  for (const point of series) {
    if (point.date > onOrBeforeDate) break;
    result = point.value;
  }
  return result;
}

interface RawRow {
  series_id: string;
  observation_date: string;
  value: number;
}

interface NavSharesPoint {
  date: string;
  nav: number;
  shares: number;
}

// SSGA's NAV-history files are NOT split-adjusted -- confirmed live
// 2026-09-15: XLK's shares outstanding jumped from 325.8M to 650.6M on
// 2025-12-05 (a clean 2:1 split, matched by NAV simultaneously halving,
// 291.04 -> 146.62), which silently corrupted any return/flow calculation
// spanning that date (365d NAV return showed a fake -32% "decline"). Real
// daily creation/redemption is small relative to shares outstanding
// (observed: XLF's biggest recent move was ~1.4% across 4 days) -- a split
// moves shares by a large, roughly-integer-or-reciprocal multiple in a
// single day, so a generous band (ratio > 1.5 or < 0.6667) distinguishes
// the two without false-positiving on genuine flow. Detected splits are
// adjusted retroactively (shares x ratio, NAV / ratio for every point
// strictly before the split), same convention as any "split-adjusted"
// price series. Processing chronologically forward means multiple splits
// compound correctly -- each detected split only touches points already
// known to be strictly before it.
function adjustForSplits(points: NavSharesPoint[]): NavSharesPoint[] {
  const adjusted = points.map((p) => ({ ...p }));
  for (let i = 1; i < adjusted.length; i++) {
    const prevShares = adjusted[i - 1].shares;
    if (prevShares === 0) continue;
    const ratio = adjusted[i].shares / prevShares;
    if (ratio > 1.5 || ratio < 0.6667) {
      for (let j = 0; j < i; j++) {
        adjusted[j].shares *= ratio;
        adjusted[j].nav /= ratio;
      }
    }
  }
  return adjusted;
}

// PostgREST silently caps every response at a project-level max-rows
// setting (confirmed live 2026-09-15: 1000, regardless of how the query is
// built) -- the ~6,600+ rows this query needs (26 series x ~254 trading
// days/yr) would otherwise get truncated to the oldest slice, making
// "latest" land on a stale middle-of-history row instead of today. Paginate
// with .range() until a short page comes back. Secondary sort on
// series_id makes the order fully deterministic across page boundaries --
// many rows share the same observation_date across these 26 series, and
// offset-based pagination needs a stable order to avoid skipping or
// duplicating rows when ties exist on the primary sort column alone.
async function fetchAllDataPoints(seriesIds: string[], cutoff: string): Promise<RawRow[]> {
  const pageSize = 1000;
  let offset = 0;
  const allRows: RawRow[] = [];
  while (true) {
    const { data, error } = await supabase
      .from("data_points")
      .select("series_id, observation_date, value")
      .in("series_id", seriesIds)
      .gte("observation_date", cutoff)
      .order("observation_date", { ascending: true })
      .order("series_id", { ascending: true })
      .range(offset, offset + pageSize - 1);

    if (error) {
      throw new Error(`Failed to read sector-rotation data_points: ${error.message}`);
    }
    const page = data ?? [];
    allRows.push(...page);
    if (page.length < pageSize) break;
    offset += pageSize;
  }
  return allRows;
}

/**
 * One batched (paginated) Supabase read for the full
 * {TICKER}_NAV/{TICKER}_SHARES_OUT series set over the trailing 370 days,
 * rather than the ~130 separate round trips 13 tickers x 2 series x (1
 * latest + 4 lookback fetches) would otherwise need. Computed entirely
 * from that one result set.
 */
export async function computeSectorRotation(): Promise<TickerRotation[]> {
  const seriesIds = SECTOR_TICKERS.flatMap(({ ticker }) => [`${ticker}_NAV`, `${ticker}_SHARES_OUT`]);
  const cutoff = subtractDays(new Date().toISOString().slice(0, 10), 370);

  const rows = await fetchAllDataPoints(seriesIds, cutoff);

  const bySeriesId = new Map<string, SeriesPoint[]>();
  for (const row of rows) {
    const list = bySeriesId.get(row.series_id) ?? [];
    list.push({ date: row.observation_date, value: row.value });
    bySeriesId.set(row.series_id, list);
  }

  const round = (n: number) => Math.round(n * 100) / 100;

  return SECTOR_TICKERS.map(({ ticker, label }) => {
    const rawNavSeries = bySeriesId.get(`${ticker}_NAV`) ?? [];
    const rawSharesSeries = bySeriesId.get(`${ticker}_SHARES_OUT`) ?? [];

    // NAV and shares come from the same source rows (ssga.ts writes both
    // per date in lockstep), so they're 1:1 by index here -- safe to pair
    // by position rather than needing a date-keyed join.
    const paired: NavSharesPoint[] = rawNavSeries.map((nav, i) => ({
      date: nav.date,
      nav: nav.value,
      shares: rawSharesSeries[i]?.value ?? NaN,
    }));
    const splitAdjusted = adjustForSplits(paired);
    const navSeries: SeriesPoint[] = splitAdjusted.map((p) => ({ date: p.date, value: p.nav }));
    const sharesSeries: SeriesPoint[] = splitAdjusted.map((p) => ({ date: p.date, value: p.shares }));

    const latestNav = navSeries.length > 0 ? navSeries[navSeries.length - 1] : null;
    const latestShares = sharesSeries.length > 0 ? sharesSeries[sharesSeries.length - 1] : null;

    const navReturn: Partial<Record<`${LookbackWindow}d`, number>> = {};
    const flowEstimate: Partial<Record<`${LookbackWindow}d`, number>> = {};
    const rotationRead: Partial<Record<`${LookbackWindow}d`, RotationRead>> = {};

    if (latestNav && latestShares) {
      for (const windowDays of LOOKBACK_WINDOWS_DAYS) {
        const pastDate = subtractDays(latestNav.date, windowDays);
        const pastNav = valueOnOrBefore(navSeries, pastDate);
        const pastShares = valueOnOrBefore(sharesSeries, pastDate);
        const key = `${windowDays}d` as const;

        let windowReturn: number | null = null;
        let windowFlow: number | null = null;

        if (pastNav !== null && pastNav !== 0) {
          windowReturn = round(((latestNav.value - pastNav) / pastNav) * 100);
          navReturn[key] = windowReturn;
        }
        if (pastShares !== null) {
          // Approximate creation/redemption dollar flow -- share-count
          // delta (price-independent) x latest NAV. Not reinvestment-
          // adjusted, not a complete sector-flow picture (see module doc).
          windowFlow = Math.round((latestShares.value - pastShares) * latestNav.value);
          flowEstimate[key] = windowFlow;
        }
        if (windowReturn !== null && windowFlow !== null) {
          rotationRead[key] = classifyRotation(windowReturn, windowFlow);
        }
      }
    }

    return {
      symbol: ticker,
      label,
      as_of: latestNav?.date ?? null,
      nav_return_pct: navReturn,
      flow_estimate_usd: flowEstimate,
      rotation_read: rotationRead,
    };
  });
}
