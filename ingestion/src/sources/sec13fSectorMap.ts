import ExcelJS from "exceljs";
import { SECTOR_TICKERS } from "./ssga.js";

// CUSIP -> sector mapping for sec13f.ts, built from SSGA's free per-fund
// *holdings* files (distinct from the NAV-history file ssga.ts already
// uses) -- confirmed live: holdings-daily-us-en-{ticker}.xlsx exists,
// unauthenticated, for all 11 Select Sector SPDRs, and its "Identifier"
// column carries real CUSIPs (verified against known NVDA/AAPL/MSFT
// values). A stock's sector here = whichever SPDR's current holdings file
// it appears in -- GICS sector membership is mutually exclusive by
// construction, so this should never produce a CUSIP mapped to two
// sectors; checked below rather than silently trusted.
//
// Coverage gap, worth stating plainly: this only covers stocks that are
// CURRENT members of one of these 11 funds (a large/mid-cap, roughly
// S&P-500-ish universe). Small/mid caps, international names, and
// non-equity 13F line items (bonds, options, warrants) are never in this
// map and are correctly dropped by sec13f.ts's CUSIP filter -- a deliberate
// coverage boundary, not a bug, same "federal-only"/"ETF-vehicle-level"
// style caveat as this project's other contextual indicators.
export interface SectorMapEntry {
  ticker: string;
  label: string;
}

const HOLDINGS_URL = (ticker: string) =>
  `https://www.ssga.com/library-content/products/fund-data/etfs/us/holdings-daily-us-en-${ticker.toLowerCase()}.xlsx`;

async function fetchHoldings(ticker: string): Promise<{ cusip: string; name: string }[]> {
  const res = await fetch(HOLDINGS_URL(ticker), {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; market-sentiment-analyzer/1.0)" },
  });
  if (!res.ok) {
    throw new Error(`SSGA holdings request failed for ${ticker}: HTTP ${res.status}`);
  }
  const buffer = await res.arrayBuffer();

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as never);
  const sheet = workbook.worksheets[0];
  if (!sheet) {
    throw new Error(`SSGA holdings file for ${ticker} has no worksheet`);
  }

  // Header row (row 5 — 4 metadata rows above it: Fund Name, Ticker Symbol,
  // "Holdings: As of ...", blank) is Name/Ticker/Identifier/SEDOL/Weight/
  // Sector/Shares Held/Local Currency -- confirmed against a real XLK file.
  // Only rows where Weight parses as a real number are holdings; cash-sweep
  // ("SSI US GOV MONEY MARKET..."), straight cash ("US DOLLAR"), futures
  // contracts, and trailing disclaimer paragraphs all fail that check and
  // are dropped, not CUSIPs this map should ever claim to know about.
  const holdings: { cusip: string; name: string }[] = [];
  sheet.eachRow((row) => {
    const name = row.getCell(1).value;
    const identifier = row.getCell(3).value;
    const weight = row.getCell(5).value;
    if (typeof weight !== "number" || typeof identifier !== "string" || typeof name !== "string") return;
    if (!/^[A-Z0-9]{9}$/.test(identifier)) return; // CUSIPs are always 9 alphanumeric chars
    holdings.push({ cusip: identifier, name });
  });
  return holdings;
}

export async function buildSectorCusipMap(): Promise<Map<string, SectorMapEntry>> {
  const map = new Map<string, SectorMapEntry>();
  const conflicts: string[] = [];

  for (const { ticker, label } of SECTOR_TICKERS) {
    if (ticker === "SPY" || ticker === "GLD") continue; // not sector-mappable targets themselves
    const holdings = await fetchHoldings(ticker);
    for (const { cusip } of holdings) {
      const existing = map.get(cusip);
      if (existing && existing.ticker !== ticker) {
        conflicts.push(`${cusip}: already mapped to ${existing.ticker}, also found in ${ticker}`);
        continue; // keep the first mapping seen rather than silently overwriting
      }
      map.set(cusip, { ticker, label });
    }
    console.log(`  13F sector map: ${ticker} — ${holdings.length} holdings`);
  }

  if (conflicts.length > 0) {
    // Shouldn't happen (GICS sector membership is mutually exclusive) --
    // logged loudly rather than silently trusted, per this project's
    // "verify, don't assume" convention.
    console.warn(`13F sector map: ${conflicts.length} CUSIP(s) appeared under more than one sector ETF:`);
    for (const c of conflicts) console.warn(`  - ${c}`);
  }

  return map;
}
