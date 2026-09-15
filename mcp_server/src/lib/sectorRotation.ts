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

export interface TickerRotation {
  symbol: string;
  label: string;
  as_of: string | null;
  nav_return_pct: Partial<Record<`${LookbackWindow}d`, number>>;
  flow_estimate_usd: Partial<Record<`${LookbackWindow}d`, number>>;
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
    const navSeries = bySeriesId.get(`${ticker}_NAV`) ?? [];
    const sharesSeries = bySeriesId.get(`${ticker}_SHARES_OUT`) ?? [];
    const latestNav = navSeries.length > 0 ? navSeries[navSeries.length - 1] : null;
    const latestShares = sharesSeries.length > 0 ? sharesSeries[sharesSeries.length - 1] : null;

    const navReturn: Partial<Record<`${LookbackWindow}d`, number>> = {};
    const flowEstimate: Partial<Record<`${LookbackWindow}d`, number>> = {};

    if (latestNav && latestShares) {
      for (const windowDays of LOOKBACK_WINDOWS_DAYS) {
        const pastDate = subtractDays(latestNav.date, windowDays);
        const pastNav = valueOnOrBefore(navSeries, pastDate);
        const pastShares = valueOnOrBefore(sharesSeries, pastDate);
        const key = `${windowDays}d` as const;

        if (pastNav !== null && pastNav !== 0) {
          navReturn[key] = round(((latestNav.value - pastNav) / pastNav) * 100);
        }
        if (pastShares !== null) {
          // Approximate creation/redemption dollar flow -- share-count
          // delta (price-independent) x latest NAV. Not reinvestment-
          // adjusted, not a complete sector-flow picture (see module doc).
          flowEstimate[key] = Math.round((latestShares.value - pastShares) * latestNav.value);
        }
      }
    }

    return {
      symbol: ticker,
      label,
      as_of: latestNav?.date ?? null,
      nav_return_pct: navReturn,
      flow_estimate_usd: flowEstimate,
    };
  });
}
