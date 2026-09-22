import { supabase, getLatestDataPoint } from "./supabase.js";
import { getValueOnOrBefore, subtractDays } from "./seriesDelta.js";

// Fiscal Dominance Regime Checklist (added 2026-09-22, see
// reference_docs/rules/crash-check-rules.md's section of the same name for
// the full methodology writeup). Deliberately NOT a single synthesized
// "score" -- this system avoids manufacturing false precision elsewhere
// (crash_probability_pct is explicitly labeled a judgment call, not a
// statistic), and a fiscal-dominance regime is a structural, slow-moving
// classification, not something 4 numbers can cleanly average into one
// verdict. Each function here returns its own real numbers plus an honest
// caveat; synthesis (if any) is the LLM narrative layer's job, informed by
// these, same division of labor as crash-type diagnosis.

export interface TaylorRuleGapResult {
  actual_fed_funds_pct: number;
  taylor_implied_rate_pct: number;
  gap_pct: number;
  inflation_yoy_pct: number;
  unemployment_gap_pct: number;
  as_of: string;
  assumptions: string;
}

/**
 * Original Taylor (1993) rule: i = r* + pi + 0.5(pi - pi*) + 0.5*(output gap).
 * Assumes r* = 2% (neutral real rate) and pi* = 2% (Fed's target) -- the
 * paper's own original constants, not fitted to this data. Output gap is
 * approximated via Okun's Law (coefficient 2) from UNRATE minus CBO's NROU
 * (natural rate), since no free real-time potential-GDP series exists.
 * Algebraically: i = 1 + 1.5*pi - (UNRATE - NROU).
 *
 * A persistently negative gap (actual Fed funds below the Taylor-implied
 * rate) means policy is running looser than inflation/employment alone
 * would justify -- one candidate signal of a Fed constrained by the debt
 * burden, not proof of it (a genuinely dovish Fed for ordinary reasons
 * looks identical in this one number).
 */
export async function computeTaylorRuleGap(): Promise<TaylorRuleGapResult | null> {
  const [dff, unrate, nrou, cpiLatest] = await Promise.all([
    getLatestDataPoint("DFF"),
    getLatestDataPoint("UNRATE"),
    getLatestDataPoint("NROU"),
    getLatestDataPoint("CPIAUCSL"),
  ]);
  if (!dff || !unrate || !nrou || !cpiLatest) return null;

  const cpiYearAgo = await getValueOnOrBefore("CPIAUCSL", subtractDays(cpiLatest.observation_date, 365));
  if (cpiYearAgo === null || cpiYearAgo === 0) return null;

  const inflationYoy = ((cpiLatest.value - cpiYearAgo) / cpiYearAgo) * 100;
  const unemploymentGap = unrate.value - nrou.value;
  const taylorRate = 1 + 1.5 * inflationYoy - unemploymentGap;
  const round2 = (n: number) => Math.round(n * 100) / 100;

  return {
    actual_fed_funds_pct: round2(dff.value),
    taylor_implied_rate_pct: round2(taylorRate),
    gap_pct: round2(dff.value - taylorRate),
    inflation_yoy_pct: round2(inflationYoy),
    unemployment_gap_pct: round2(unemploymentGap),
    as_of: dff.observation_date,
    assumptions:
      "Assumes a 2% neutral real rate and 2% inflation target (original Taylor 1993 constants, not fitted) and approximates the output-gap term via Okun's Law (coefficient 2) on UNRATE minus CBO's NROU. Negative gap_pct = actual policy looser than the formula prescribes -- one candidate fiscal-dominance signal, not proof by itself.",
  };
}

export interface PrimaryBalanceResult {
  total_balance_usd_billions: number;
  net_interest_usd_billions: number;
  primary_balance_usd_billions: number;
  fiscal_year_as_of: string;
  net_interest_as_of: string;
  caveat: string;
}

/**
 * primary_balance = total_balance + net_interest (since total_balance =
 * revenue - total_outlays = revenue - noninterest_outlays - interest =
 * primary_balance - interest). A negative primary_balance means the
 * government is running a deficit even EXCLUDING interest payments -- the
 * textbook "active fiscal policy" signature in the Leeper fiscal/monetary
 * regime framework (the fiscal authority isn't adjusting the primary
 * balance to stabilize debt).
 */
export async function computePrimaryBalance(): Promise<PrimaryBalanceResult | null> {
  const [fyfsd, netInterest] = await Promise.all([
    getLatestDataPoint("FYFSD"),
    getLatestDataPoint("A091RC1Q027SBEA"),
  ]);
  if (!fyfsd || !netInterest) return null;

  const round1 = (n: number) => Math.round(n * 10) / 10;
  const totalBalanceUsdBillions = fyfsd.value / 1000; // FYFSD is $ millions
  const primaryBalance = totalBalanceUsdBillions + netInterest.value;

  return {
    total_balance_usd_billions: round1(totalBalanceUsdBillions),
    net_interest_usd_billions: round1(netInterest.value),
    primary_balance_usd_billions: round1(primaryBalance),
    fiscal_year_as_of: fyfsd.observation_date,
    net_interest_as_of: netInterest.observation_date,
    caveat:
      "total_balance is OMB's actual annual fiscal-year cash-basis total (FYFSD); net_interest is BEA's NIPA accrual-basis quarterly annualized rate (A091RC1Q027SBEA) -- a different period and accounting convention, combined here as a structural approximation, not a precisely reconciled figure.",
  };
}

export interface NetInterestBurdenResult {
  net_interest_usd_billions: number;
  gdp_usd_billions: number;
  net_interest_pct_gdp: number;
  revenue_usd_billions: number | null;
  net_interest_pct_revenue: number | null;
  as_of: string;
}

/**
 * Two cuts of the same net-interest burden, not two separate checks --
 * added 2026-09-22 (external review) after verifying FGRECPT (BEA's
 * broader "Federal government current receipts" total: tax + social-
 * insurance + other) is the correct revenue denominator, not the narrower
 * W006RC1Q027SBEA ("current TAX receipts" only), which would understate
 * revenue by excluding social-insurance contributions and so overstate the
 * burden. pct_revenue is closer to the actual debt-sustainability question
 * ("can the government service this from its own income") than pct_gdp,
 * and is the more commonly-cited cut in practice. revenue fields are
 * nullable independent of the GDP fields -- a gap in FGRECPT shouldn't
 * null out the pct_gdp reading this check already had.
 */
export async function computeNetInterestBurden(): Promise<NetInterestBurdenResult | null> {
  const [netInterest, gdp, revenue] = await Promise.all([
    getLatestDataPoint("A091RC1Q027SBEA"),
    getLatestDataPoint("GDP"),
    getLatestDataPoint("FGRECPT"),
  ]);
  if (!netInterest || !gdp || gdp.value === 0) return null;

  return {
    net_interest_usd_billions: Math.round(netInterest.value * 10) / 10,
    gdp_usd_billions: Math.round(gdp.value * 10) / 10,
    net_interest_pct_gdp: Math.round((netInterest.value / gdp.value) * 10000) / 100,
    revenue_usd_billions: revenue ? Math.round(revenue.value * 10) / 10 : null,
    net_interest_pct_revenue: revenue && revenue.value !== 0 ? Math.round((netInterest.value / revenue.value) * 10000) / 100 : null,
    as_of: netInterest.observation_date,
  };
}

export interface GoldRealYieldCorrelationResult {
  correlation: number;
  window_calendar_days: number;
  observation_count: number;
  as_of: string;
  typical_historical_note: string;
}

const CORRELATION_WINDOW_DAYS = 180;

interface SeriesPoint {
  date: string;
  value: number;
}

// Same paginated-read pattern as sectorRotation.ts's fetchAllDataPoints
// (duplicated, not shared -- that one is keyed to a multi-series batch read,
// this one to a single series over a shorter window, different enough
// shapes that sharing would add an abstraction for two call sites).
async function fetchSeriesHistorySince(seriesId: string, cutoff: string): Promise<SeriesPoint[]> {
  const pageSize = 1000;
  let offset = 0;
  const rows: SeriesPoint[] = [];
  while (true) {
    const { data, error } = await supabase
      .from("data_points")
      .select("observation_date, value")
      .eq("series_id", seriesId)
      .gte("observation_date", cutoff)
      .order("observation_date", { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (error) {
      throw new Error(`Failed to read ${seriesId} history: ${error.message}`);
    }
    const page = data ?? [];
    rows.push(...page.map((r) => ({ date: r.observation_date as string, value: r.value as number })));
    if (page.length < pageSize) break;
    offset += pageSize;
  }
  return rows;
}

function pearsonCorrelation(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 2 || ys.length !== n) return null;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0,
    denomX = 0,
    denomY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    num += dx * dy;
    denomX += dx * dx;
    denomY += dy * dy;
  }
  if (denomX === 0 || denomY === 0) return null;
  return num / Math.sqrt(denomX * denomY);
}

// "pct": day-over-day % change (for a price-like series). "level": raw
// day-over-day change (for a yield/rate-like series already in % units).
// "negLevel": the negated day-over-day change -- used to turn a yield
// series into a bond-PRICE proxy (yield falls => price proxy rises), so a
// correlation against it reads the same direction convention as the
// commonly-quoted "stock-bond correlation" statistic (price vs. price),
// not the differently-signed "stock vs. yield" relationship.
type ChangeKind = "pct" | "level" | "negLevel";

function changeBetween(prev: number, curr: number, kind: ChangeKind): number | null {
  if (kind === "pct") return prev === 0 ? null : (curr - prev) / prev;
  const change = curr - prev;
  return kind === "negLevel" ? -change : change;
}

export interface RollingCorrelationResult {
  correlation: number;
  window_calendar_days: number;
  observation_count: number;
  as_of: string;
}

/**
 * Rolling correlation between two series' day-over-day changes (never raw
 * levels -- a levels-based correlation over a multi-month window would
 * mostly just reflect that both series trend, not whether they move
 * together day to day). Walks series A's own consecutive observation
 * dates (not a fixed calendar grid) and looks up series B's value at each
 * of those same two dates -- skipping any date B has no observation for,
 * rather than assuming both series publish on identical days. This is the
 * "rolling-correlation infrastructure" the architecture doc previously
 * listed as deliberately deferred, not started -- generalized from the
 * gold/real-yield check (built 2026-09-22) into a reusable helper the same
 * day, for the stock-bond correlation check below.
 */
async function computeRollingCorrelation(
  seriesAId: string,
  seriesAKind: ChangeKind,
  seriesBId: string,
  seriesBKind: ChangeKind,
  windowDays: number,
): Promise<RollingCorrelationResult | null> {
  const cutoff = subtractDays(new Date().toISOString().slice(0, 10), windowDays);
  const [historyA, historyB] = await Promise.all([
    fetchSeriesHistorySince(seriesAId, cutoff),
    fetchSeriesHistorySince(seriesBId, cutoff),
  ]);
  if (historyA.length < 10 || historyB.length < 10) return null;

  const bByDate = new Map(historyB.map((p) => [p.date, p.value]));
  const changesA: number[] = [];
  const changesB: number[] = [];
  const alignedDates: string[] = [];
  for (let i = 1; i < historyA.length; i++) {
    const prevDateA = historyA[i - 1].date;
    const currDateA = historyA[i].date;
    const prevB = bByDate.get(prevDateA);
    const currB = bByDate.get(currDateA);
    if (prevB === undefined || currB === undefined) continue;

    const changeA = changeBetween(historyA[i - 1].value, historyA[i].value, seriesAKind);
    const changeB = changeBetween(prevB, currB, seriesBKind);
    if (changeA === null || changeB === null) continue;

    changesA.push(changeA);
    changesB.push(changeB);
    alignedDates.push(currDateA);
  }

  const correlation = pearsonCorrelation(changesA, changesB);
  if (correlation === null || alignedDates.length === 0) return null;

  return {
    correlation: Math.round(correlation * 1000) / 1000,
    window_calendar_days: windowDays,
    observation_count: alignedDates.length,
    as_of: alignedDates[alignedDates.length - 1],
  };
}

export async function computeGoldRealYieldCorrelation(): Promise<GoldRealYieldCorrelationResult | null> {
  const result = await computeRollingCorrelation("GLD", "pct", "DFII10", "level", CORRELATION_WINDOW_DAYS);
  if (!result) return null;
  return {
    ...result,
    typical_historical_note:
      "Gold and real yields typically run modestly negative -- higher real yields raise the opportunity cost of holding a non-yielding asset. A correlation near zero or positive is the more distinctive fiscal-dominance/debasement-hedge signature: gold rising for reasons unrelated to (or despite) the usual real-yield relationship. Not backtested/calibrated -- a first cut, same tier as every other divergence-style read in this system.",
  };
}

export interface StockBondCorrelationResult extends RollingCorrelationResult {
  typical_historical_note: string;
}

/**
 * SPY's daily % change vs. a bond-PRICE proxy built from DGS10 (yield
 * change negated -- yield falling means bond prices rose, so this reads in
 * the same direction convention as the commonly-quoted "stock-bond
 * correlation," not "stock vs. yield"). Added 2026-09-22 (external
 * review): the classic 60/40-portfolio diversification signal -- stocks
 * and bonds typically move oppositely (negative correlation: equity
 * selloffs drive flight-to-safety bond buying). 2022 was the well-known
 * real-world case where this flipped positive (inflation drove both risk
 * assets down together) -- exactly the "stocks and bonds selling off
 * together" regime-shift signature a debt/inflation crisis would produce.
 */
export async function computeStockBondCorrelation(): Promise<StockBondCorrelationResult | null> {
  const result = await computeRollingCorrelation("SPY", "pct", "DGS10", "negLevel", CORRELATION_WINDOW_DAYS);
  if (!result) return null;
  return {
    ...result,
    typical_historical_note:
      "Stocks and bonds typically run negative -- equity selloffs usually drive flight-to-safety bond buying (the classic 60/40 diversification benefit). A correlation near zero or positive is the 2022-style regime-shift signature: both risk assets selling off together, historically seen when inflation/rate concerns dominate over growth concerns. Not backtested/calibrated -- a first cut, same tier as every other divergence-style read in this system.",
  };
}
