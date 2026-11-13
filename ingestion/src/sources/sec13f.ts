import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";
import { writeDataPoints, type DataPoint } from "../lib/supabase.js";
import { buildSectorCusipMap, type SectorMapEntry } from "./sec13fSectorMap.js";

// Institutional 13F sector tilt (backlog: 13F/insider positioning
// discussion) -- the "confirm the past" half, companion to secForm4.ts's
// insider cluster-buy signal (the "forward view" half). Aggregated across
// the FULL universe of 13F filers (not a curated "top investors" list, per
// explicit user direction), isolating institutional-only positioning --
// unlike sector_rotation's ETF creation/redemption flow, which mixes
// retail + institutional money.
//
// What is measured: institutions' holdings of the STOCKS in each sector
// (every CUSIP in that Select Sector SPDR's current holdings file, see
// sec13fSectorMap.ts) -- not holdings of the SPDR fund itself. Reworked
// 2026-11-12: the original QoQ change in total dollar value was mostly
// the quarter's price move (XLK Q2 2026: +47.9% value, +43% price, ~+3%
// shares), counted put/call option rows as holdings, and swung with the
// set of filers. The headline series is now price-neutral net buying over
// institutions that filed in both quarters, options excluded -- see
// computeNetBuying / processQuarter below.
//
// NOT part of the daily ingest.ts loop -- quarterly cadence, a large batch
// job (the real ZIP is ~96MB compressed / ~400MB uncompressed with ~3.8M
// INFOTABLE rows), triggered manually like backfill.ts via
// .github/workflows/sec13f.yml. SEC's own publish schedule is irregular
// enough (confirmed: the URL path prefix itself changed between quarters,
// datastandardsinnovation vs structureddata) that a blind cron risks
// silently processing stale or missing data -- a human checking the index
// page before running this is the safer default for v1.
const INDEX_PAGE_URL = "https://www.sec.gov/data-research/sec-markets-data/form-13f-data-sets";
const CONTACT = process.env.SEC_EDGAR_CONTACT_EMAIL ?? "no-contact-configured@example.com";
const USER_AGENT = `market-sentiment-analyzer ${CONTACT}`;

interface ZipLink {
  url: string;
  sortKey: number; // epoch ms of the period this ZIP covers, for picking "latest"
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * Parses both ZIP-filename conventions SEC has used (confirmed live, both
 * appear on the current index page): date-range style
 * ("01jun2026-31aug2026_form13f.zip" -- sortKey = the range's END date) and
 * the older per-quarter style ("2023q4_form13f.zip" -- sortKey = that
 * quarter's end date). Returns null for anything else on the page (the
 * readme PDF, metadata files, etc.).
 */
function parseZipFilename(filename: string): number | null {
  const rangeMatch = /^\d{2}[a-z]{3}\d{4}-(\d{2})([a-z]{3})(\d{4})_form13f\.zip$/i.exec(filename);
  if (rangeMatch) {
    const [, day, monAbbr, year] = rangeMatch;
    const month = MONTHS[monAbbr.toLowerCase()];
    if (month === undefined) return null;
    return Date.UTC(Number(year), month, Number(day));
  }
  const quarterMatch = /^(\d{4})q([1-4])_form13f\.zip$/i.exec(filename);
  if (quarterMatch) {
    const [, year, quarter] = quarterMatch;
    return Date.UTC(Number(year), Number(quarter) * 3, 0); // last day of that quarter's final month
  }
  return null;
}

/**
 * Scrapes the index page's own links rather than hardcoding a URL pattern
 * -- the path prefix (datastandardsinnovation vs structureddata) isn't
 * stable across quarters (confirmed live), so constructing a URL instead
 * of reading it from the page risks silently 404ing on the next quarter.
 */
async function listAvailableZips(): Promise<ZipLink[]> {
  const res = await fetch(INDEX_PAGE_URL, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) {
    throw new Error(`SEC 13F index page fetch failed: HTTP ${res.status}`);
  }
  const html = await res.text();

  const links: ZipLink[] = [];
  const hrefPattern = /href="([^"]+_form13f\.zip)"/gi;
  let match: RegExpExecArray | null;
  while ((match = hrefPattern.exec(html)) !== null) {
    const href = match[1];
    const filename = href.split("/").pop() ?? "";
    const sortKey = parseZipFilename(filename);
    if (sortKey === null) continue;
    const url = href.startsWith("http") ? href : new URL(href, "https://www.sec.gov").toString();
    links.push({ url, sortKey });
  }
  return links;
}

async function downloadToTempFile(url: string, destPath: string): Promise<void> {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok || !res.body) {
    throw new Error(`13F ZIP download failed for ${url}: HTTP ${res.status}`);
  }
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(destPath));
}

function openZip(zipPath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) reject(err ?? new Error("yauzl.open returned no zipfile"));
      else resolve(zipfile);
    });
  });
}

/**
 * Streams one named entry's lines through `onLine`, never buffering the
 * full decompressed content -- the whole reason this uses yauzl instead of
 * a load-it-all-into-memory unzip library. Entries not matching `entryName`
 * are skipped without reading their stream, so this is cheap to call twice
 * (once for SUBMISSION.tsv, once for INFOTABLE.tsv) against the same ZIP.
 */
async function streamEntryLines(zipPath: string, entryName: string, onLine: (line: string) => void): Promise<void> {
  const zipfile = await openZip(zipPath);
  return new Promise((resolve, reject) => {
    let found = false;
    zipfile.on("error", reject);
    zipfile.on("entry", (entry) => {
      // Older windows nest every table in a folder (01JUN2025-31AUG2025_form13f/SUBMISSION.tsv).
      if (entry.fileName !== entryName && !entry.fileName.endsWith(`/${entryName}`)) {
        zipfile.readEntry();
        return;
      }
      found = true;
      zipfile.openReadStream(entry, (err, readStream) => {
        if (err || !readStream) {
          reject(err ?? new Error(`Could not open read stream for ${entryName}`));
          return;
        }
        const rl = readline.createInterface({ input: readStream });
        rl.on("line", onLine);
        rl.on("close", () => {
          zipfile.readEntry();
        });
      });
    });
    zipfile.on("end", () => {
      if (!found) reject(new Error(`Entry ${entryName} not found in ZIP`));
      else resolve();
    });
    zipfile.readEntry();
  });
}

interface TsvReader {
  columns: Map<string, number>;
  get(fields: string[], name: string): string | undefined;
}

function makeTsvReader(headerLine: string): TsvReader {
  const headers = headerLine.replace(/^﻿/, "").split("\t");
  const columns = new Map(headers.map((h, i) => [h.trim(), i]));
  return {
    columns,
    get(fields: string[], name: string) {
      const i = columns.get(name);
      return i === undefined ? undefined : fields[i];
    },
  };
}


interface Submissions {
  periodIso: string;
  /** Original 13F-HR filings for the dominant period only: accession -> filer CIK. */
  accessionToCik: Map<string, string>;
  filerCount: number; // distinct CIKs
}

/**
 * Original 13F-HR filings in this window, restricted to the single DOMINANT
 * period, with each filing's CIK (the filer) so two quarters can be compared
 * over the same set of institutions.
 *
 * Confirmed live (2026-10-02 real backfill run): a filing window's
 * SUBMISSION.tsv isn't just "this window's real quarter" -- it also
 * contains a long tail of stray original 13F-HR filings reporting on
 * long-past quarters (e.g. a manager filing late for the first time, or
 * correcting a gap), going back to 2001 in the window actually tested.
 * Aggregating those produced ~100 bogus historical "quarters" per sector
 * ticker. Fixed by keeping only the period with by far the most distinct
 * filings (the one this window's 45-day deadline was actually for).
 */
async function readSubmissions(zipPath: string): Promise<Submissions> {
  const rows: { accession: string; cik: string; period: string }[] = [];
  const periodCounts = new Map<string, number>();
  let reader: TsvReader | null = null;
  await streamEntryLines(zipPath, "SUBMISSION.tsv", (line) => {
    if (!reader) {
      reader = makeTsvReader(line);
      return;
    }
    const fields = line.split("\t");
    if (reader.get(fields, "SUBMISSIONTYPE") !== "13F-HR") return;
    const accession = reader.get(fields, "ACCESSION_NUMBER");
    const cik = reader.get(fields, "CIK");
    const period = reader.get(fields, "PERIODOFREPORT");
    if (!accession || !cik || !period) return;
    rows.push({ accession, cik, period });
    periodCounts.set(period, (periodCounts.get(period) ?? 0) + 1);
  });

  let dominantPeriod: string | null = null;
  let dominantCount = 0;
  for (const [period, count] of periodCounts) {
    if (count > dominantCount) {
      dominantPeriod = period;
      dominantCount = count;
    }
  }
  const periodIso = dominantPeriod ? periodToIsoDate(dominantPeriod) : null;
  if (!periodIso) throw new Error(`13F: no parseable dominant period in ${path.basename(zipPath)}`);

  const accessionToCik = new Map<string, string>();
  for (const r of rows) if (r.period === dominantPeriod) accessionToCik.set(r.accession, r.cik);
  const filerCount = new Set(accessionToCik.values()).size;
  console.log(`  13F: dominant period ${periodIso} (${dominantCount} filings, ${filerCount} filers) -- ${periodCounts.size - 1} other stray period(s) discarded`);
  return { periodIso, accessionToCik, filerCount };
}

// SEC's PERIODOFREPORT is DD-MMM-YYYY (e.g. "30-JUN-2026") -- reuses the
// same month-abbreviation convention as ssga.ts's NAV-history dates, but
// with the day/month order swapped, so a separate small parser rather than
// importing ssga.ts's normalizeDate (which isn't exported, and isn't worth
// exporting for a one-line difference).
function periodToIsoDate(period: string): string | null {
  const match = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(period.trim());
  if (!match) return null;
  const [, day, monAbbr, year] = match;
  const month = MONTHS[monAbbr.toLowerCase()];
  if (month === undefined) return null;
  return `${year}-${String(month + 1).padStart(2, "0")}-${day.padStart(2, "0")}`;
}

interface Holding {
  shares: number;
  valueUsd: number;
}

interface Position {
  cik: string;
  shares: number;
  valueUsd: number;
}

interface Infotable {
  /** Clean share positions in sector stocks, per CUSIP. */
  byCusip: Map<string, Position[]>;
  /** NAMEOFISSUER per CUSIP, for log lines only. */
  names: Map<string, string>;
  periodIso: string;
}

// A row's own $/share must sit within this factor of the stock's median
// $/share across all filers that quarter. Every filer values a holding at
// the same quarter-end price, so honest rows cluster tightly; the errors
// this catches are off by ~1000x (confirmed live 2026-11-12: CalSTRS
// reported 3.99B Microsoft shares worth $0.01B for Q2 2026 -- the value and
// share columns swapped -- and T. Rowe Price reported Q1 Microsoft value in
// thousands). One such row moved Microsoft's total institutional share
// count x1.83 on its own.
const PRICE_BAND = 1.3;

/**
 * Streams INFOTABLE.tsv (the ~3.8M-row holdings table) once and keeps clean
 * share positions in the sector map's stocks:
 * - original 13F-HR filings for the dominant period only (see readSubmissions)
 * - no options: rows with a PUTCALL value are puts/calls (a put is a bet
 *   AGAINST the stock, often a hedge), previously summed in as ownership
 * - SSHPRNAMTTYPE "SH" only ("PRN" is a principal amount, not shares)
 * - $/share within PRICE_BAND of that stock's median (see above)
 */
async function readInfotable(zipPath: string, submissions: Submissions, sectorMap: Map<string, SectorMapEntry>): Promise<Infotable> {
  const raw = new Map<string, Position[]>();
  const names = new Map<string, string>();
  let reader: TsvReader | null = null;
  let rowsSeen = 0;
  let optionRows = 0;
  let optionValueUsd = 0;

  await streamEntryLines(zipPath, "INFOTABLE.tsv", (line) => {
    if (!reader) {
      reader = makeTsvReader(line);
      return;
    }
    rowsSeen++;
    const fields = line.split("\t");
    const cusip = reader.get(fields, "CUSIP");
    if (!cusip || !sectorMap.has(cusip)) return;
    const accession = reader.get(fields, "ACCESSION_NUMBER");
    const cik = accession ? submissions.accessionToCik.get(accession) : undefined;
    if (!cik) return; // amendment, notice-only, or a stray non-dominant period

    const valueUsd = Number(reader.get(fields, "VALUE"));
    const shares = Number(reader.get(fields, "SSHPRNAMT"));
    if (!Number.isFinite(valueUsd) || !Number.isFinite(shares)) return;
    if ((reader.get(fields, "PUTCALL") ?? "").trim() !== "") {
      optionRows++;
      optionValueUsd += valueUsd;
      return;
    }
    if ((reader.get(fields, "SSHPRNAMTTYPE") ?? "").trim() !== "SH" || shares <= 0 || valueUsd <= 0) return;
    if (!names.has(cusip)) names.set(cusip, (reader.get(fields, "NAMEOFISSUER") ?? cusip).trim());
    const list = raw.get(cusip) ?? [];
    list.push({ cik, shares, valueUsd });
    raw.set(cusip, list);
  });

  const byCusip = new Map<string, Position[]>();
  let kept = 0;
  let offPriceRows = 0;
  let offPriceValueUsd = 0;
  for (const [cusip, rows] of raw) {
    const prices = rows.map((r) => r.valueUsd / r.shares).sort((a, b) => a - b);
    const median = prices[Math.floor(prices.length / 2)];
    const clean = rows.filter((r) => {
      const price = r.valueUsd / r.shares;
      const ok = price >= median / PRICE_BAND && price <= median * PRICE_BAND;
      if (!ok) {
        offPriceRows++;
        offPriceValueUsd += r.valueUsd;
      }
      return ok;
    });
    kept += clean.length;
    if (clean.length) byCusip.set(cusip, clean);
  }

  const b = (usd: number) => `$${(usd / 1e9).toFixed(1)}B`;
  console.log(
    `  13F ${submissions.periodIso}: scanned ${rowsSeen.toLocaleString("en-US")} rows; kept ${kept.toLocaleString("en-US")} sector share positions; ` +
      `skipped ${optionRows.toLocaleString("en-US")} option rows (${b(optionValueUsd)}) and ${offPriceRows.toLocaleString("en-US")} off-price rows (${b(offPriceValueUsd)})`,
  );
  return { byCusip, names, periodIso: submissions.periodIso };
}

/** Totals per CUSIP, optionally over a subset of filers. */
function totals(table: Infotable, onlyCiks: Set<string> | null): Map<string, Holding> {
  const out = new Map<string, Holding>();
  for (const [cusip, rows] of table.byCusip) {
    let shares = 0;
    let valueUsd = 0;
    for (const r of rows) {
      if (onlyCiks && !onlyCiks.has(r.cik)) continue;
      shares += r.shares;
      valueUsd += r.valueUsd;
    }
    if (shares > 0) out.set(cusip, { shares, valueUsd });
  }
  return out;
}

const SPLIT_RATIOS = [2, 3, 4, 5, 8, 10, 15, 20, 25, 30, 40, 50];
// Institutions as a group never really add or shed half of a large
// company in one quarter; a change that big after split restatement is a
// merger, spin-off or identifier change, so that stock sits the quarter out.
const MAX_REAL_CHANGE = 1.5;

/**
 * A share-count ratio within 15% of a standard split ratio, with the price
 * moving the other way by roughly the same factor (allowing for a +/-60%
 * real price move), is a split. Returns the ratio to divide the new share
 * count by (1 if no split; < 1 for a reverse split).
 */
function splitRatio(shareRatio: number, priceRatio: number): number {
  for (const r of SPLIT_RATIOS) {
    for (const ratio of [r, 1 / r]) {
      if (Math.abs(shareRatio / ratio - 1) < 0.15 && priceRatio > ratio / 1.6 && priceRatio < ratio * 1.6) return ratio;
    }
  }
  return 1;
}

/**
 * Price-neutral institutional net buying per sector between two quarters:
 *   sum(this quarter's shares x last quarter's price) / sum(last quarter's value) - 1
 * over the sector's stocks held in both quarters. A price move changes
 * neither side, so only a change in shares held moves it.
 *
 * Only continuing positions count: a stock that appears or disappears
 * between quarters in this large-cap universe is a listing, takeover or
 * identifier change, not institutions buying or selling a whole company.
 */
function computeNetBuying(
  prior: Map<string, Holding>,
  current: Map<string, Holding>,
  sectorMap: Map<string, SectorMapEntry>,
  names: Map<string, string>,
): Map<string, number> {
  const sums = new Map<string, { atPriorPrices: number; priorValue: number }>();
  const splits: string[] = [];
  const excluded: string[] = [];
  for (const [cusip, before] of prior) {
    const after = current.get(cusip);
    const ticker = sectorMap.get(cusip)?.ticker;
    if (!after || !ticker) continue;
    const priorPrice = before.valueUsd / before.shares;
    const ratio = splitRatio(after.shares / before.shares, priorPrice / (after.valueUsd / after.shares));
    const shareChange = after.shares / ratio / before.shares;
    const label = names.get(cusip) ?? cusip;
    if (ratio !== 1) splits.push(`${label} ${ratio >= 1 ? `${ratio}:1` : `1:${1 / ratio}`}`);
    if (shareChange > MAX_REAL_CHANGE || shareChange < 1 / MAX_REAL_CHANGE) {
      excluded.push(`${label} (${ticker}, x${shareChange.toFixed(2)}, $${(before.valueUsd / 1e9).toFixed(1)}B)`);
      continue;
    }
    const s = sums.get(ticker) ?? { atPriorPrices: 0, priorValue: 0 };
    s.atPriorPrices += (after.shares / ratio) * priorPrice;
    s.priorValue += before.valueUsd;
    sums.set(ticker, s);
  }
  if (splits.length) console.log(`  13F: restated splits: ${splits.join(", ")}`);
  if (excluded.length) console.log(`  13F: sat out (corporate action, share change beyond +/-50%): ${excluded.join(", ")}`);

  const netBuyingPct = new Map<string, number>();
  for (const [ticker, s] of sums) {
    if (s.priorValue > 0) netBuyingPct.set(ticker, (s.atPriorPrices / s.priorValue - 1) * 100);
  }
  return netBuyingPct;
}

function monthsBetween(fromIso: string, toIso: string): number {
  const [fy, fm] = fromIso.split("-").map(Number);
  const [ty, tm] = toIso.split("-").map(Number);
  return (ty - fy) * 12 + (tm - fm);
}

interface QuarterResult {
  periodIso: string;
  points: DataPoint[];
  netBuyingPct: Map<string, number>;
}

/**
 * One quarter's data_points, from its parsed INFOTABLE plus the previous
 * quarter's:
 * - `{ticker}_13F_NET_BUYING_PCT` -- price-neutral net buying (see
 *   computeNetBuying), over institutions that filed in BOTH quarters only,
 *   so a change in who files can't masquerade as buying or selling.
 * - `{ticker}_13F_VALUE_USD` -- total value of clean share positions in the
 *   sector's stocks, all filers. Context only.
 * - `SEC13F_FILERS` / `SEC13F_MATCHED_FILERS` -- coverage, so a jump in the
 *   number of filers is visible rather than silent.
 */
function processQuarter(
  prior: { submissions: Submissions; table: Infotable },
  current: { submissions: Submissions; table: Infotable },
  sectorMap: Map<string, SectorMapEntry>,
): QuarterResult {
  const gap = monthsBetween(prior.submissions.periodIso, current.submissions.periodIso);
  if (gap !== 3) {
    throw new Error(`13F: expected consecutive quarters, got ${prior.submissions.periodIso} -> ${current.submissions.periodIso} (${gap} months apart)`);
  }
  const priorCiks = new Set(prior.submissions.accessionToCik.values());
  const matched = new Set([...current.submissions.accessionToCik.values()].filter((cik) => priorCiks.has(cik)));
  console.log(`  13F: ${matched.size} of ${current.submissions.filerCount} filers in ${current.submissions.periodIso} also filed for ${prior.submissions.periodIso}`);

  const netBuyingPct = computeNetBuying(totals(prior.table, matched), totals(current.table, matched), sectorMap, current.table.names);
  const valueBySector = new Map<string, number>();
  for (const [cusip, h] of totals(current.table, null)) {
    const ticker = sectorMap.get(cusip)!.ticker;
    valueBySector.set(ticker, (valueBySector.get(ticker) ?? 0) + h.valueUsd);
  }

  const date = current.submissions.periodIso;
  const points: DataPoint[] = [
    { series_id: "SEC13F_FILERS", source: "SEC_13F", observation_date: date, value: current.submissions.filerCount, unit: "count" },
    { series_id: "SEC13F_MATCHED_FILERS", source: "SEC_13F", observation_date: date, value: matched.size, unit: "count" },
  ];
  for (const [ticker, pct] of netBuyingPct) {
    points.push({ series_id: `${ticker}_13F_NET_BUYING_PCT`, source: "SEC_13F", source_series_code: ticker, observation_date: date, value: Math.round(pct * 100) / 100, unit: "percent" });
  }
  for (const [ticker, valueUsd] of valueBySector) {
    // INFOTABLE's VALUE is whole USD, not thousands (confirmed live
    // 2026-10-02: Cardinal Health VALUE=388237 for 5,250 shares = $73.95/share).
    points.push({ series_id: `${ticker}_13F_VALUE_USD`, source: "SEC_13F", source_series_code: ticker, observation_date: date, value: Math.round(valueUsd), unit: "usd" });
  }
  return { periodIso: date, points, netBuyingPct };
}

export interface Sec13fOptions {
  /** Compute and print results without writing anything to Supabase. */
  dryRun?: boolean;
}

/**
 * Downloads the newest `quarters + 1` ZIPs (each quarter needs the one
 * before it) and processes `quarters` quarters, newest first. Each ZIP's
 * INFOTABLE is parsed once and kept only while a neighbouring quarter
 * still needs it.
 */
async function run(quarters: number, { dryRun = false }: Sec13fOptions): Promise<number> {
  const zips = await listAvailableZips();
  if (zips.length < quarters + 1) {
    throw new Error(`Need ${quarters + 1} 13F ZIPs on the SEC index page, found ${zips.length} — page structure may have changed`);
  }
  zips.sort((a, b) => b.sortKey - a.sortKey);
  const needed = zips.slice(0, quarters + 1);

  const dir = await mkdtemp(path.join(tmpdir(), "sec13f-"));
  try {
    const sectorMap = await buildSectorCusipMap();
    const parse = async (i: number) => {
      const p = path.join(dir, `q${i}.zip`);
      console.log(`  13F: downloading ${needed[i].url}`);
      await downloadToTempFile(needed[i].url, p);
      const submissions = await readSubmissions(p);
      const table = await readInfotable(p, submissions, sectorMap);
      await rm(p, { force: true });
      return { submissions, table };
    };

    let total = 0;
    let current = await parse(0);
    for (let i = 0; i < quarters; i++) {
      const prior = await parse(i + 1);
      const result = processQuarter(prior, current, sectorMap);
      const summary = [...result.netBuyingPct]
        .sort((a, b) => b[1] - a[1])
        .map(([t, v]) => `${t} ${v >= 0 ? "+" : ""}${v.toFixed(2)}%`);
      console.log(`  13F ${result.periodIso} net buying (price-neutral, matched filers): ${summary.join(", ")}`);
      if (!dryRun) await writeDataPoints(result.points);
      total += result.points.length;
      current = prior;
    }
    return total;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Latest available quarter only -- the manual, workflow_dispatch-triggered steady state. */
export function fetchSec13f(options: Sec13fOptions = {}): Promise<number> {
  return run(1, options);
}

const BACKFILL_QUARTERS = 4; // ~1 year of quarters; downloads 5 ZIPs (~100MB each)

export function fetchSec13fBackfill(options: Sec13fOptions = {}): Promise<number> {
  return run(BACKFILL_QUARTERS, options);
}
