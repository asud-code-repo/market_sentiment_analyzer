import ExcelJS from "exceljs";
import type { DataPoint } from "../lib/supabase.js";

// State Street (SSGA) publishes a free, unauthenticated daily NAV-history
// file for every SPDR fund it issues -- verified live 2026-09-15 against
// XLF/XLK/XLE/SPY/GLD (all HTTP 200, not bot-blocked, unlike every
// commercial ETF-data aggregator checked first: ICI, ETF.com, and etfdb.com
// all 403'd on the same kind of request). Columns: Date, NAV, Shares
// Outstanding, Total Net Assets. Shares Outstanding only changes via real
// creation/redemption activity -- confirmed moving day-to-day with real
// numbers (XLF: +13M shares across 4 trading days in mid-Sept 2026) -- so
// it's a genuine, price-independent flow signal, not a price proxy like
// everything else this system has tried for "where is capital rotating."
//
// Scope is the 11 Select Sector SPDRs + SPY + GLD (also an SSGA product) --
// deliberately not TLT/DBC, which are iShares/Invesco and have no confirmed
// SSGA-equivalent free source. This is ETF-vehicle-level flow, not a
// complete picture of money entering/leaving the underlying sector
// (investors can get tech exposure via QQQ/VGT/SMH instead of XLK) -- see
// crash-check-rules.md's Contextual Indicators section for the full caveat.
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

interface SsgaRow {
  date: string; // YYYY-MM-DD
  nav: number;
  sharesOutstanding: number;
}

// SSGA's DD-MMM-YYYY date format (e.g. "14-Sep-2026") -> this project's
// standard YYYY-MM-DD observation_date convention.
const MONTHS: Record<string, string> = {
  Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
  Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12",
};

function normalizeDate(raw: string): string | null {
  const match = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(raw.trim());
  if (!match) return null;
  const [, day, monAbbr, year] = match;
  const month = MONTHS[monAbbr];
  if (!month) return null;
  return `${year}-${month}-${day.padStart(2, "0")}`;
}

/**
 * Fetches and parses one ticker's full NAV-history file. Rows are returned
 * newest-first, matching the file's own order -- the "navhist" sheet has 3
 * header rows (Fund Name, Ticker Symbol, blank) then a
 * Date/NAV/Shares Outstanding/Total Net Assets header row, then data rows
 * newest-first, then trailing disclaimer text rows with no date in column 1.
 */
async function fetchTickerHistory(ticker: string): Promise<SsgaRow[]> {
  const url = `https://www.ssga.com/library-content/products/fund-data/etfs/us/navhist-us-en-${ticker.toLowerCase()}.xlsx`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; market-sentiment-analyzer/1.0)" },
  });
  if (!res.ok) {
    throw new Error(`SSGA NAV-history request failed for ${ticker}: HTTP ${res.status}`);
  }
  const buffer = await res.arrayBuffer();

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as never);
  const sheet = workbook.worksheets[0];
  if (!sheet) {
    throw new Error(`SSGA NAV-history file for ${ticker} has no worksheet`);
  }

  const rows: SsgaRow[] = [];
  sheet.eachRow((row) => {
    const rawDate = row.getCell(1).value;
    const rawNav = row.getCell(2).value;
    const rawShares = row.getCell(3).value;
    if (typeof rawDate !== "string" || typeof rawNav !== "number" || typeof rawShares !== "number") {
      return; // header/metadata/disclaimer rows -- not a data row
    }
    const date = normalizeDate(rawDate);
    if (!date) return;
    rows.push({ date, nav: rawNav, sharesOutstanding: rawShares });
  });

  return rows;
}

function toDataPoints(ticker: string, rows: SsgaRow[]): DataPoint[] {
  const points: DataPoint[] = [];
  for (const row of rows) {
    points.push({
      series_id: `${ticker}_NAV`,
      source: "SSGA",
      source_series_code: ticker,
      observation_date: row.date,
      value: row.nav,
      unit: "usd",
    });
    points.push({
      series_id: `${ticker}_SHARES_OUT`,
      source: "SSGA",
      source_series_code: ticker,
      observation_date: row.date,
      value: row.sharesOutstanding,
      unit: "shares",
    });
  }
  return points;
}

// Best-effort like Massive (see ingest.ts) -- supplementary contextual data,
// not one of the 6 gating indicators, so a source hiccup shouldn't fail the
// whole daily run. Only the last 5 rows are needed daily -- same
// weekend/holiday-gap tolerance as Massive's grouped-daily lookback.
export async function fetchSsga(): Promise<DataPoint[]> {
  const allPoints: DataPoint[] = [];
  for (const { ticker } of SECTOR_TICKERS) {
    const rows = await fetchTickerHistory(ticker);
    allPoints.push(...toDataPoints(ticker, rows.slice(0, 5)));
  }
  return allPoints;
}

const BACKFILL_YEARS = 5; // matches FRED's existing backfill depth -- covers
// the 2020 and 2022 crash episodes without writing 20+ years of largely
// redundant history (SSGA's files go back to each fund's inception).

export async function fetchSsgaBackfill(): Promise<DataPoint[]> {
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - BACKFILL_YEARS);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const allPoints: DataPoint[] = [];
  for (const { ticker } of SECTOR_TICKERS) {
    const rows = await fetchTickerHistory(ticker);
    const withinWindow = rows.filter((r) => r.date >= cutoffStr);
    allPoints.push(...toDataPoints(ticker, withinWindow));
    console.log(`  SSGA backfill: ${ticker} — ${withinWindow.length} observations since ${cutoffStr}`);
  }
  return allPoints;
}
