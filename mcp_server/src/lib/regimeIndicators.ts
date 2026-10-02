import { supabase, getLatestDataPoint } from "./supabase.js";
import { subtractDays } from "./seriesDelta.js";

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
//
// 2026-10-02 revision (external review of the dashboard card): every check
// now also returns a prior-period comparison, since the checklist's own
// guidance is "watch the trend, not one reading" and a single latest value
// gave no way to do that. Net interest and the primary balance moved to
// OMB fiscal-year series (FYOINT/FYFR/FYGDP alongside FYFSD) -- the BEA
// NIPA series used before (A091RC1Q027SBEA) is GROSS interest payments
// (incl. imputed interest on federal pension liabilities), not net
// interest, and pairing a latest-quarter annualized figure with the prior
// full fiscal year's deficit mixed periods. The Taylor Rule gap now uses
// core PCE (the Fed's own target measure) instead of headline CPI.

interface Point {
  date: string;
  value: number;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Latest observation on or before a date, with its date (seriesDelta's
 * getValueOnOrBefore returns the value only). */
async function getPointOnOrBefore(seriesId: string, onOrBeforeDate: string): Promise<Point | null> {
  const { data, error } = await supabase
    .from("data_points")
    .select("observation_date, value")
    .eq("series_id", seriesId)
    .lte("observation_date", onOrBeforeDate)
    .order("observation_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to read ${seriesId} on/before ${onOrBeforeDate}: ${error.message}`);
  }
  return data ? { date: data.observation_date as string, value: data.value as number } : null;
}

/** Most recent `count` observations, newest first. */
async function getRecentPoints(seriesId: string, count: number): Promise<Point[]> {
  const { data, error } = await supabase
    .from("data_points")
    .select("observation_date, value")
    .eq("series_id", seriesId)
    .order("observation_date", { ascending: false })
    .limit(count);
  if (error) {
    throw new Error(`Failed to read recent ${seriesId} history: ${error.message}`);
  }
  return (data ?? []).map((r) => ({ date: r.observation_date as string, value: r.value as number }));
}

/** Inner-joins several series on observation_date, newest first -- the
 * quarterly/fiscal-year ratios below must divide same-period values, never
 * one series' latest by another's. */
function joinByDate(...series: Point[][]): { date: string; values: number[] }[] {
  const maps = series.slice(1).map((s) => new Map(s.map((p) => [p.date, p.value])));
  const joined: { date: string; values: number[] }[] = [];
  for (const p of series[0]) {
    const others = maps.map((m) => m.get(p.date));
    if (others.some((v) => v === undefined)) continue;
    joined.push({ date: p.date, values: [p.value, ...(others as number[])] });
  }
  return joined;
}

/** YoY % change of a monthly price index, as of its latest print on or
 * before `asOf`. */
async function inflationYoyAsOf(seriesId: string, asOf: string): Promise<number | null> {
  const latest = await getPointOnOrBefore(seriesId, asOf);
  if (!latest) return null;
  const yearAgo = await getPointOnOrBefore(seriesId, subtractDays(latest.date, 365));
  if (!yearAgo || yearAgo.value === 0) return null;
  return ((latest.value - yearAgo.value) / yearAgo.value) * 100;
}

export interface TaylorRuleGapResult {
  actual_fed_funds_pct: number;
  taylor_implied_rate_pct: number;
  gap_pct: number;
  inflation_measure: "core_pce" | "headline_cpi";
  inflation_yoy_pct: number;
  unemployment_gap_pct: number;
  headline_cpi_yoy_pct: number | null;
  headline_cpi_taylor_implied_rate_pct: number | null;
  headline_cpi_gap_pct: number | null;
  gap_one_year_ago_pct: number | null;
  as_of: string;
  assumptions: string;
}

interface TaylorPoint {
  fedFunds: number;
  unemploymentGap: number;
  corePce: number | null;
  cpi: number | null;
}

async function taylorInputsAsOf(asOf: string): Promise<TaylorPoint | null> {
  const [dff, unrate, nrou, corePce, cpi] = await Promise.all([
    getPointOnOrBefore("DFF", asOf),
    getPointOnOrBefore("UNRATE", asOf),
    getPointOnOrBefore("NROU", asOf),
    inflationYoyAsOf("PCEPILFE", asOf),
    inflationYoyAsOf("CPIAUCSL", asOf),
  ]);
  if (!dff || !unrate || !nrou) return null;
  return { fedFunds: dff.value, unemploymentGap: unrate.value - nrou.value, corePce, cpi };
}

const taylorRate = (inflationYoy: number, unemploymentGap: number) => 1 + 1.5 * inflationYoy - unemploymentGap;

/**
 * Original Taylor (1993) rule: i = r* + pi + 0.5(pi - pi*) + 0.5*(output gap).
 * Assumes r* = 2% (neutral real rate) and pi* = 2% (Fed's target) -- the
 * paper's own original constants, not fitted to this data. Output gap is
 * approximated via Okun's Law (coefficient 2) from UNRATE minus CBO's NROU
 * (natural rate), since no free real-time potential-GDP series exists.
 * Algebraically: i = 1 + 1.5*pi - (UNRATE - NROU).
 *
 * pi is core PCE YoY (PCEPILFE) -- the measure the Fed's 2% target is
 * actually defined on. Headline CPI typically runs above core PCE, and
 * every extra point of pi adds 1.5pts to the implied rate, so a CPI-based
 * rule overstates how loose policy is; the CPI version is still returned
 * alongside for comparison. Falls back to CPI (and says so via
 * inflation_measure) only if PCEPILFE has no data yet.
 *
 * A persistently negative gap (actual Fed funds below the Taylor-implied
 * rate) means policy is running looser than inflation/employment alone
 * would justify -- one candidate signal of a Fed constrained by the debt
 * burden, not proof of it (a genuinely dovish Fed for ordinary reasons
 * looks identical in this one number). gap_one_year_ago_pct is the same
 * calculation on the inputs as they stood 365 days earlier.
 */
export async function computeTaylorRuleGap(): Promise<TaylorRuleGapResult | null> {
  const dffLatest = await getLatestDataPoint("DFF");
  if (!dffLatest) return null;
  const asOf = dffLatest.observation_date;
  const [now, yearAgo] = await Promise.all([taylorInputsAsOf(asOf), taylorInputsAsOf(subtractDays(asOf, 365))]);
  if (!now) return null;

  const measure = now.corePce !== null ? "core_pce" : "headline_cpi";
  const inflation = now.corePce ?? now.cpi;
  if (inflation === null) return null;
  const implied = taylorRate(inflation, now.unemploymentGap);
  const cpiImplied = now.cpi !== null ? taylorRate(now.cpi, now.unemploymentGap) : null;

  const yearAgoInflation = yearAgo ? (measure === "core_pce" ? yearAgo.corePce : yearAgo.cpi) : null;
  const yearAgoGap =
    yearAgo && yearAgoInflation !== null ? yearAgo.fedFunds - taylorRate(yearAgoInflation, yearAgo.unemploymentGap) : null;

  return {
    actual_fed_funds_pct: round2(now.fedFunds),
    taylor_implied_rate_pct: round2(implied),
    gap_pct: round2(now.fedFunds - implied),
    inflation_measure: measure,
    inflation_yoy_pct: round2(inflation),
    unemployment_gap_pct: round2(now.unemploymentGap),
    headline_cpi_yoy_pct: now.cpi !== null ? round2(now.cpi) : null,
    headline_cpi_taylor_implied_rate_pct: cpiImplied !== null ? round2(cpiImplied) : null,
    headline_cpi_gap_pct: cpiImplied !== null ? round2(now.fedFunds - cpiImplied) : null,
    gap_one_year_ago_pct: yearAgoGap !== null ? round2(yearAgoGap) : null,
    as_of: asOf,
    assumptions:
      `Inflation input is ${measure === "core_pce" ? "core PCE YoY (PCEPILFE), the Fed's own target measure" : "headline CPI YoY -- core PCE (PCEPILFE) has no data yet, so this reads looser than the core-PCE version will"}. Assumes a 2% neutral real rate and 2% inflation target (original Taylor 1993 constants, not fitted) and approximates the output-gap term via Okun's Law (coefficient 2) on UNRATE minus CBO's NROU. Negative gap_pct = actual policy looser than the formula prescribes -- one candidate fiscal-dominance signal, not proof by itself. headline_cpi_* fields show the same rule on headline CPI for comparison; it typically implies a higher rate (more negative gap).`,
  };
}

/** Joined OMB fiscal-year rows (FYFSD, FYOINT, FYFR, FYGDP), newest first.
 * FYFSD/FYOINT/FYFR are $ millions, FYGDP is $ billions. */
async function getFiscalYearRows(count: number) {
  const [fyfsd, fyoint, fyfr, fygdp] = await Promise.all([
    getRecentPoints("FYFSD", count),
    getRecentPoints("FYOINT", count),
    getRecentPoints("FYFR", count),
    getRecentPoints("FYGDP", count),
  ]);
  return joinByDate(fyfsd, fyoint, fyfr, fygdp).map(({ date, values: [deficit, interest, receipts, gdp] }) => ({
    fiscal_year: date.slice(0, 4),
    total_balance_usd_billions: deficit / 1000,
    net_interest_usd_billions: interest / 1000,
    receipts_usd_billions: receipts / 1000,
    gdp_usd_billions: gdp,
  }));
}

export interface PrimaryBalanceResult {
  total_balance_usd_billions: number;
  net_interest_usd_billions: number;
  primary_balance_usd_billions: number;
  primary_balance_pct_gdp: number;
  fiscal_year: string;
  prior_fiscal_year_primary_balance_usd_billions: number | null;
  prior_fiscal_year_primary_balance_pct_gdp: number | null;
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
 *
 * Both legs are OMB fiscal-year actuals for the SAME fiscal year (FYFSD +
 * FYOINT, joined on observation date) -- the CBO/OMB definition of the
 * primary deficit. Also returned as % of fiscal-year GDP (FYGDP), the
 * comparable-across-years form, with the prior fiscal year for trend.
 */
export async function computePrimaryBalance(): Promise<PrimaryBalanceResult | null> {
  const rows = await getFiscalYearRows(3);
  if (rows.length === 0) return null;
  const primary = (r: (typeof rows)[number]) => r.total_balance_usd_billions + r.net_interest_usd_billions;
  const pctGdp = (r: (typeof rows)[number]) => (primary(r) / r.gdp_usd_billions) * 100;
  const [latest, prior] = rows;

  return {
    total_balance_usd_billions: round1(latest.total_balance_usd_billions),
    net_interest_usd_billions: round1(latest.net_interest_usd_billions),
    primary_balance_usd_billions: round1(primary(latest)),
    primary_balance_pct_gdp: round2(pctGdp(latest)),
    fiscal_year: latest.fiscal_year,
    prior_fiscal_year_primary_balance_usd_billions: prior ? round1(primary(prior)) : null,
    prior_fiscal_year_primary_balance_pct_gdp: prior ? round2(pctGdp(prior)) : null,
    caveat:
      "OMB fiscal-year actuals (FYFSD total balance + FYOINT net interest, same fiscal year), so this is annual and lags: the latest reading is the most recently completed fiscal year, not the current one.",
  };
}

export interface NetInterestBurdenResult {
  fiscal_year: string;
  net_interest_usd_billions: number;
  net_interest_pct_gdp: number;
  net_interest_pct_revenue: number;
  prior_fiscal_year_pct_gdp: number | null;
  prior_fiscal_year_pct_revenue: number | null;
  five_years_earlier_fiscal_year: string | null;
  five_years_earlier_pct_gdp: number | null;
  five_years_earlier_pct_revenue: number | null;
  nipa_gross_interest_pct_gdp: number | null;
  nipa_gross_interest_pct_revenue: number | null;
  nipa_as_of: string | null;
  caveat: string;
}

/**
 * Two cuts of the same net-interest burden, not two separate checks: % of
 * GDP and % of total federal receipts. pct_revenue is closer to the actual
 * debt-sustainability question ("can the government service this from its
 * own income") and is the more commonly-cited cut in practice.
 *
 * Headline numbers are OMB fiscal-year NET interest (FYOINT) over FYGDP and
 * FYFR -- the same basis CBO and Treasury report. Before 2026-10-02 this
 * used BEA's A091RC1Q027SBEA, which is GROSS NIPA interest payments
 * (includes imputed interest on federal employee pension liabilities and
 * nets out none of the government's interest receipts), so it read
 * materially higher than the commonly-cited net figure. That NIPA ratio is
 * kept as nipa_gross_* -- it updates quarterly, so it's the timelier
 * direction-of-travel read between annual OMB prints, but its LEVEL isn't
 * comparable to the headline. Trend: prior fiscal year and five years
 * earlier.
 */
export async function computeNetInterestBurden(): Promise<NetInterestBurdenResult | null> {
  const [rows, nipaInterest, nipaGdp, nipaReceipts] = await Promise.all([
    getFiscalYearRows(6),
    getRecentPoints("A091RC1Q027SBEA", 4),
    getRecentPoints("GDP", 4),
    getRecentPoints("FGRECPT", 4),
  ]);
  if (rows.length === 0) return null;
  const pctGdp = (r: (typeof rows)[number]) => round2((r.net_interest_usd_billions / r.gdp_usd_billions) * 100);
  const pctRevenue = (r: (typeof rows)[number]) => round2((r.net_interest_usd_billions / r.receipts_usd_billions) * 100);
  const [latest, prior] = rows;
  const fiveBack = rows[5];
  const [nipa] = joinByDate(nipaInterest, nipaGdp, nipaReceipts);

  return {
    fiscal_year: latest.fiscal_year,
    net_interest_usd_billions: round1(latest.net_interest_usd_billions),
    net_interest_pct_gdp: pctGdp(latest),
    net_interest_pct_revenue: pctRevenue(latest),
    prior_fiscal_year_pct_gdp: prior ? pctGdp(prior) : null,
    prior_fiscal_year_pct_revenue: prior ? pctRevenue(prior) : null,
    five_years_earlier_fiscal_year: fiveBack ? fiveBack.fiscal_year : null,
    five_years_earlier_pct_gdp: fiveBack ? pctGdp(fiveBack) : null,
    five_years_earlier_pct_revenue: fiveBack ? pctRevenue(fiveBack) : null,
    nipa_gross_interest_pct_gdp: nipa ? round2((nipa.values[0] / nipa.values[1]) * 100) : null,
    nipa_gross_interest_pct_revenue: nipa ? round2((nipa.values[0] / nipa.values[2]) * 100) : null,
    nipa_as_of: nipa ? nipa.date : null,
    caveat:
      "Headline is OMB fiscal-year NET interest (FYOINT) / FYGDP and / FYFR -- annual, so it lags up to a year. nipa_gross_* is BEA's quarterly GROSS interest payments (A091RC1Q027SBEA, includes imputed pension interest) over GDP / FGRECPT: timelier, but reads structurally higher -- use it for direction between annual prints, not as a level.",
  };
}

export interface GovtSpendingShareResult {
  govt_spending_usd_billions: number;
  gdp_usd_billions: number;
  govt_spending_pct_gdp: number;
  one_year_earlier_pct_gdp: number | null;
  five_years_earlier_pct_gdp: number | null;
  as_of: string;
  caveat: string;
}

/**
 * Added 2026-09-28, prompted by an external research note ("Austerity Is a
 * Sound Bite. Inflation Is the Plan.") arguing that above a certain
 * government-spending-share-of-GDP threshold, cutting spending shrinks the
 * tax base it's measured against faster than it closes the deficit --
 * belt-tightening becomes structurally difficult, then near-impossible.
 * That's a different question from federal_debt_pct_gdp above (a debt
 * STOCK) -- this is spending as a FLOW share of the economy, closer to
 * what actually determines whether a cut is mechanically survivable.
 *
 * Deliberately NOT banded against the source note's own threshold framework
 * (<30% easy / 30-40% difficult / ~50%+ near-impossible) -- those bands are
 * for GENERAL government (federal + state + local combined, the note's own
 * Exhibit 4), explicitly labeled the author's own view, not an established
 * empirical finding. FGEXPND is FEDERAL ONLY (no free clean "general
 * government, all levels, % of GDP" series was found on FRED -- the obvious
 * series IDs don't resolve), so it reads structurally lower than those
 * bands assume; rescaling them without real validation would manufacture a
 * precision this system doesn't have. Report the number and its own
 * multi-year trend instead (4 and 20 quarters earlier, same-quarter pairs).
 */
export async function computeGovtSpendingShare(): Promise<GovtSpendingShareResult | null> {
  const [govtSpending, gdp] = await Promise.all([getRecentPoints("FGEXPND", 21), getRecentPoints("GDP", 21)]);
  const rows = joinByDate(govtSpending, gdp).filter((r) => r.values[1] !== 0);
  if (rows.length === 0) return null;
  const pct = (r: (typeof rows)[number]) => round2((r.values[0] / r.values[1]) * 100);
  const latest = rows[0];
  const quartersBack = (n: number) => rows.find((r) => r.date === subtractQuarters(latest.date, n));
  const oneYear = quartersBack(4);
  const fiveYears = quartersBack(20);

  return {
    govt_spending_usd_billions: round1(latest.values[0]),
    gdp_usd_billions: round1(latest.values[1]),
    govt_spending_pct_gdp: pct(latest),
    one_year_earlier_pct_gdp: oneYear ? pct(oneYear) : null,
    five_years_earlier_pct_gdp: fiveYears ? pct(fiveYears) : null,
    as_of: latest.date,
    caveat:
      "FGEXPND is FEDERAL government spending only -- it excludes state/local spending, so it reads meaningfully lower than a 'general government, all levels' figure (the more commonly-cited version internationally, and the basis for any external threshold framework like <30%/30-40%/50%+ 'belt-tightening becomes difficult/near-impossible' bands). No clean free 'general government, all levels' series was found on FRED. Watch the multi-year trend and rate of change, not a single level -- no validated threshold band applies to this federal-only figure.",
  };
}

/** Quarter-start date n quarters before a quarter-start date (YYYY-MM-01). */
function subtractQuarters(dateStr: string, n: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - 3 * n);
  return d.toISOString().slice(0, 10);
}

export interface GoldRealYieldCorrelationResult {
  correlation: number;
  window_calendar_days: number;
  observation_count: number;
  as_of: string;
  prior_window_correlation: number | null;
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
async function fetchSeriesHistorySince(seriesId: string, cutoff: string, end: string): Promise<SeriesPoint[]> {
  const pageSize = 1000;
  let offset = 0;
  const rows: SeriesPoint[] = [];
  while (true) {
    const { data, error } = await supabase
      .from("data_points")
      .select("observation_date, value")
      .eq("series_id", seriesId)
      .gte("observation_date", cutoff)
      .lte("observation_date", end)
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
  windowEnd: string = new Date().toISOString().slice(0, 10),
): Promise<RollingCorrelationResult | null> {
  const cutoff = subtractDays(windowEnd, windowDays);
  const [historyA, historyB] = await Promise.all([
    fetchSeriesHistorySince(seriesAId, cutoff, windowEnd),
    fetchSeriesHistorySince(seriesBId, cutoff, windowEnd),
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

/**
 * prior_window_correlation is the same calculation over the immediately
 * preceding, non-overlapping 180-day window -- the trend comparison (a
 * drift toward zero matters more than any one window's level).
 */
export async function computeGoldRealYieldCorrelation(): Promise<GoldRealYieldCorrelationResult | null> {
  const today = new Date().toISOString().slice(0, 10);
  const [result, prior] = await Promise.all([
    computeRollingCorrelation("GLD", "pct", "DFII10", "level", CORRELATION_WINDOW_DAYS, today),
    computeRollingCorrelation("GLD", "pct", "DFII10", "level", CORRELATION_WINDOW_DAYS, subtractDays(today, CORRELATION_WINDOW_DAYS)),
  ]);
  if (!result) return null;
  return {
    ...result,
    prior_window_correlation: prior ? prior.correlation : null,
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
