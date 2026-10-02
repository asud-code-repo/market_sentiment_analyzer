import { XMLParser } from "fast-xml-parser";
import { readWatchlistTickers, writeInsiderTransactions, type InsiderTransaction } from "../lib/supabase.js";

// Insider Form 4 cluster-buy signal (backlog: 13F/insider positioning
// discussion). Near-real-time per-ticker signal for the BrokerageLink
// watchlist -- Form 4 is filed within 2 business days of the actual trade
// (confirmed: SEC's Section 16 rule), unlike 13F's 45+-day lag, so this is
// the "forward view" half of that discussion; sec13f.ts (quarterly batch,
// separate file) is the "confirm the past" half.
//
// SEC requires a descriptive User-Agent with contact info for all EDGAR
// requests (confirmed via sec.gov's own accessing-edgar-data page) -- this
// repo is public on GitHub, so a real personal email is deliberately NOT
// hardcoded here. Set SEC_EDGAR_CONTACT_EMAIL as a repo secret (same
// pattern as FRED_API_KEY/MASSIVE_API_KEY) for a compliant contact string;
// falls back to a generic non-personal identifier if unset so this source
// still degrades gracefully (best-effort, not required) rather than
// hard-failing the whole daily run.
const CONTACT = process.env.SEC_EDGAR_CONTACT_EMAIL ?? "no-contact-configured@example.com";
const USER_AGENT = `market-sentiment-analyzer ${CONTACT}`;

const CLUSTER_WINDOW_DAYS = 30;
const FILING_LAG_BUFFER_DAYS = 5; // Form 4's 2-business-day filing deadline, padded generously
const LOOKBACK_DAYS = CLUSTER_WINDOW_DAYS + FILING_LAG_BUFFER_DAYS;

// Only open-market buys/sells -- excludes grants/awards (A), option
// exercises (M), tax-withholding (F), gifts (G), etc. See crash-check-rules.md
// for why these specifically are the only transaction codes that carry a
// real discretionary buy/sell signal.
const OPEN_MARKET_CODES = new Set(["P", "S"]);

function toDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`SEC request failed for ${url}: HTTP ${res.status}`);
  }
  return res.json();
}

interface TickerCikEntry {
  cik_str: number;
  ticker: string;
  title: string;
}

/**
 * company_tickers.json is a large (~5-10MB) full-market file, fetched fresh
 * each run rather than cached -- simpler than maintaining a stale local
 * mapping, and resolving against the *current* watchlist (not a hardcoded
 * CIK list) means this source tracks write_watchlist changes automatically,
 * same reasoning as massive.ts's readWatchlistTickers() usage.
 */
async function resolveWatchlistCiks(): Promise<Map<string, string>> {
  const watchlist = await readWatchlistTickers();
  if (watchlist.length === 0) return new Map();

  const all = (await fetchJson("https://www.sec.gov/files/company_tickers.json")) as Record<string, TickerCikEntry>;
  const byTicker = new Map<string, number>();
  for (const entry of Object.values(all)) {
    byTicker.set(entry.ticker, entry.cik_str);
  }

  const result = new Map<string, string>();
  for (const symbol of watchlist) {
    const cik = byTicker.get(symbol);
    if (cik === undefined) {
      console.warn(`  SEC Form 4: no CIK found for watchlist ticker ${symbol} — skipping`);
      continue;
    }
    result.set(symbol, String(cik).padStart(10, "0"));
  }
  return result;
}

interface SearchHit {
  _id: string; // "{accession-with-dashes}:{primary-document-filename}"
  _source?: { file_date?: string };
}

/**
 * One multi-CIK call covers the whole watchlist -- confirmed working
 * (efts.sec.gov/LATEST/search-index accepts a comma-joined ciks param) --
 * rather than one request per ticker.
 */
async function searchForm4Filings(ciks: string[], startDate: string, endDate: string): Promise<SearchHit[]> {
  const url = `https://efts.sec.gov/LATEST/search-index?forms=4&ciks=${ciks.join(",")}&startdt=${startDate}&enddt=${endDate}`;
  const payload = (await fetchJson(url)) as { hits?: { hits?: SearchHit[] } };
  return payload.hits?.hits ?? [];
}

// fast-xml-parser gives a bare object for a single element, or an array for
// repeated elements -- Form 4 filings commonly have exactly one
// reportingOwner/nonDerivativeTransaction, so this normalizes both shapes
// without needing to know which one a given filing used.
function toArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function truthy(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

interface ParsedOwnershipDoc {
  issuer?: { issuerCik?: unknown; issuerTradingSymbol?: unknown };
  reportingOwner?: unknown;
  aff10b5One?: unknown;
  nonDerivativeTable?: { nonDerivativeTransaction?: unknown };
}

function parseForm4Xml(xml: string, accessionNumber: string, filedAt: string): InsiderTransaction[] {
  const parser = new XMLParser();
  const doc = parser.parse(xml)?.ownershipDocument as ParsedOwnershipDoc | undefined;
  if (!doc) return [];

  const ticker = doc.issuer?.issuerTradingSymbol;
  const issuerCik = doc.issuer?.issuerCik;
  if (typeof ticker !== "string" || issuerCik === undefined) return [];

  // Multiple reportingOwners on one filing is a real but rare case (e.g. a
  // trust filing jointly with an individual) -- v1 simplification: apply
  // the first owner's identity to every transaction in this filing, same
  // "flagged limitation, not a silent assumption" treatment as the 13F-HR/A
  // amendment exclusion in sec13f.ts.
  const owners = toArray(doc.reportingOwner as Record<string, unknown> | Record<string, unknown>[]);
  const owner = owners[0] as
    | {
        reportingOwnerId?: { rptOwnerName?: unknown; rptOwnerCik?: unknown };
        reportingOwnerRelationship?: { isOfficer?: unknown; isDirector?: unknown; isTenPercentOwner?: unknown; officerTitle?: unknown };
      }
    | undefined;
  if (!owner) return [];
  if (owners.length > 1) {
    console.warn(`  SEC Form 4: filing ${accessionNumber} has ${owners.length} reporting owners — using the first for all rows`);
  }

  const is10b5_1 = truthy(doc.aff10b5One);
  const transactions = toArray(
    doc.nonDerivativeTable?.nonDerivativeTransaction as Record<string, unknown> | Record<string, unknown>[],
  );

  const rows: InsiderTransaction[] = [];
  transactions.forEach((txn, lineNo) => {
    const t = txn as {
      transactionDate?: { value?: unknown };
      transactionCoding?: { transactionCode?: unknown };
      transactionAmounts?: {
        transactionShares?: { value?: unknown };
        transactionPricePerShare?: { value?: unknown };
        transactionAcquiredDisposedCode?: { value?: unknown };
      };
    };
    const code = t.transactionCoding?.transactionCode;
    if (typeof code !== "string" || !OPEN_MARKET_CODES.has(code)) return; // drop everything but open-market P/S here

    const shares = Number(t.transactionAmounts?.transactionShares?.value);
    const txnDate = t.transactionDate?.value;
    if (!Number.isFinite(shares) || typeof txnDate !== "string") return;

    rows.push({
      ticker,
      issuer_cik: String(issuerCik),
      accession_number: accessionNumber,
      line_no: lineNo,
      owner_name: String(owner.reportingOwnerId?.rptOwnerName ?? "unknown"),
      owner_cik: String(owner.reportingOwnerId?.rptOwnerCik ?? "unknown"),
      is_officer: truthy(owner.reportingOwnerRelationship?.isOfficer),
      is_director: truthy(owner.reportingOwnerRelationship?.isDirector),
      is_ten_percent_owner: truthy(owner.reportingOwnerRelationship?.isTenPercentOwner),
      officer_title: owner.reportingOwnerRelationship?.officerTitle ? String(owner.reportingOwnerRelationship.officerTitle) : null,
      transaction_code: code,
      transaction_date: txnDate,
      shares,
      price_per_share: t.transactionAmounts?.transactionPricePerShare?.value != null
        ? Number(t.transactionAmounts.transactionPricePerShare.value)
        : null,
      acquired_disposed_code: t.transactionAmounts?.transactionAcquiredDisposedCode?.value != null
        ? String(t.transactionAmounts.transactionAcquiredDisposedCode.value)
        : null,
      is_10b5_1: is10b5_1,
      filed_at: filedAt,
    });
  });
  return rows;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Best-effort source (see ingest.ts) -- writes directly to
 * insider_transactions rather than returning DataPoint[], since individual
 * filing-level rows (owner identity, transaction code) don't fit
 * data_points' one-numeric-value-per-series-per-day shape. Returns the
 * number of rows written, for the caller's log line.
 */
export async function fetchAndWriteForm4(): Promise<number> {
  const tickerToCik = await resolveWatchlistCiks();
  if (tickerToCik.size === 0) {
    console.warn("  SEC Form 4: no watchlist tickers resolved to a CIK — nothing to fetch");
    return 0;
  }

  const endDate = toDateString(new Date());
  const startDate = toDateString(new Date(Date.now() - LOOKBACK_DAYS * 86400000));
  const hits = await searchForm4Filings([...tickerToCik.values()], startDate, endDate);

  const allRows: InsiderTransaction[] = [];
  for (const hit of hits) {
    const [accessionWithDashes, filename] = hit._id.split(":");
    if (!accessionWithDashes || !filename) continue;
    const accessionNoDashes = accessionWithDashes.replace(/-/g, "");

    // We don't yet know which issuer CIK this hit belongs to until the XML
    // is parsed (the search ciks param can match either issuer or owner),
    // so every candidate CIK in the watchlist is tried as the URL's path
    // segment until one resolves -- SEC's Archives path requires the
    // *issuer's* unpadded CIK specifically.
    let xml: string | null = null;
    for (const cik of tickerToCik.values()) {
      const unpaddedCik = String(Number(cik));
      const url = `https://www.sec.gov/Archives/edgar/data/${unpaddedCik}/${accessionNoDashes}/${filename}`;
      const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
      await sleep(150); // polite spacing, well under SEC's 10 req/s cap
      if (res.ok) {
        xml = await res.text();
        break;
      }
    }
    if (!xml) {
      console.warn(`  SEC Form 4: could not fetch XML for ${hit._id} under any watchlist CIK — skipping`);
      continue;
    }

    const filedAt = hit._source?.file_date ?? endDate; // fall back to fetch-time only if the search index omits it
    allRows.push(...parseForm4Xml(xml, accessionWithDashes, filedAt));
  }

  await writeInsiderTransactions(allRows);
  return allRows.length;
}
