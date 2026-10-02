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
      if (entry.fileName !== entryName) {
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

/**
 * ACCESSION_NUMBER -> PERIODOFREPORT (the quarter being reported, e.g.
 * "30-JUN-2026"), filtered to SUBMISSIONTYPE='13F-HR' only, AND further
 * restricted to the single DOMINANT period in this filing window.
 *
 * Confirmed live (2026-10-02 real backfill run): a filing window's
 * SUBMISSION.tsv isn't just "this window's real quarter" -- it also
 * contains a long tail of stray original 13F-HR filings reporting on
 * long-past quarters (e.g. a manager filing late for the first time, or
 * correcting a gap), going back to 2001 in the window actually tested.
 * Aggregating those into data_points produced ~100 bogus historical
 * "quarters" per sector ticker, each one a wild undercount (just the
 * handful of stragglers who happened to file during THIS window, not the
 * complete universe of managers who actually filed for that quarter back
 * when it was current) -- misleading data, not just extra noise. Fixed by
 * keeping only the period with by far the most distinct filings (the one
 * this window's 45-day deadline was actually for); every other period is
 * real but incomplete and is dropped rather than written.
 */
async function readSubmissionPeriods(zipPath: string): Promise<Map<string, string>> {
  const accessionToPeriod = new Map<string, string>();
  const periodCounts = new Map<string, number>();
  let reader: TsvReader | null = null;
  await streamEntryLines(zipPath, "SUBMISSION.tsv", (line) => {
    if (!reader) {
      reader = makeTsvReader(line);
      return;
    }
    const fields = line.split("\t");
    const submissionType = reader.get(fields, "SUBMISSIONTYPE");
    if (submissionType !== "13F-HR") return;
    const accession = reader.get(fields, "ACCESSION_NUMBER");
    const period = reader.get(fields, "PERIODOFREPORT");
    if (!accession || !period) return;
    accessionToPeriod.set(accession, period);
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
  console.log(`  13F: dominant period in this window is ${dominantPeriod} (${dominantCount} filings) -- ${periodCounts.size - 1} other stray period(s) discarded`);

  const periods = new Map<string, string>();
  for (const [accession, period] of accessionToPeriod) {
    if (period === dominantPeriod) periods.set(accession, period);
  }
  return periods;
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

interface SectorAggregate {
  valueUsd: number;
  shares: number;
}

/**
 * Streams INFOTABLE.tsv (the ~3.8M-row holdings table) line-by-line,
 * discarding every row whose CUSIP isn't in the sector map immediately --
 * nothing here ever holds more than one line's fields in memory at once,
 * regardless of the file's total size.
 */
async function aggregateInfotable(
  zipPath: string,
  sectorMap: Map<string, SectorMapEntry>,
  periods: Map<string, string>,
): Promise<Map<string, SectorAggregate>> {
  // Keyed by `${ticker}|${periodIsoDate}` -- a quarter's filings can arrive
  // across several weeks, but all roll up to the same PERIODOFREPORT.
  const bySectorQuarter = new Map<string, SectorAggregate>();
  let reader: TsvReader | null = null;
  let rowsSeen = 0;
  let rowsMatched = 0;

  await streamEntryLines(zipPath, "INFOTABLE.tsv", (line) => {
    if (!reader) {
      reader = makeTsvReader(line);
      return;
    }
    rowsSeen++;
    const fields = line.split("\t");
    const cusip = reader.get(fields, "CUSIP");
    if (!cusip) return;
    const sector = sectorMap.get(cusip);
    if (!sector) return;

    const accession = reader.get(fields, "ACCESSION_NUMBER");
    const period = accession ? periods.get(accession) : undefined;
    if (!period) return; // not a 13F-HR original filing we're counting (amendment, or notice-only)

    const periodIso = periodToIsoDate(period);
    if (!periodIso) return;

    const valueUsd = Number(reader.get(fields, "VALUE"));
    const shares = Number(reader.get(fields, "SSHPRNAMT"));
    if (!Number.isFinite(valueUsd) || !Number.isFinite(shares)) return;

    rowsMatched++;
    const key = `${sector.ticker}|${periodIso}`;
    const existing = bySectorQuarter.get(key) ?? { valueUsd: 0, shares: 0 };
    existing.valueUsd += valueUsd;
    existing.shares += shares;
    bySectorQuarter.set(key, existing);
  });

  console.log(`  13F: scanned ${rowsSeen.toLocaleString("en-US")} INFOTABLE rows, matched ${rowsMatched.toLocaleString("en-US")} to a tracked sector`);
  return bySectorQuarter;
}

function toDataPoints(bySectorQuarter: Map<string, SectorAggregate>): DataPoint[] {
  const points: DataPoint[] = [];
  for (const [key, agg] of bySectorQuarter) {
    const [ticker, periodIso] = key.split("|");
    points.push({
      series_id: `${ticker}_13F_VALUE_USD`,
      source: "SEC_13F",
      source_series_code: ticker,
      observation_date: periodIso,
      // CONFIRMED LIVE (2026-10-02): INFOTABLE's VALUE column is already
      // whole USD, NOT thousands as SEC's own 13F documentation convention
      // is widely described elsewhere -- a real sample row made this
      // unambiguous (Cardinal Health, VALUE=388237, SSHPRNAMT=5250 shares:
      // treating VALUE as thousands implies a ~$73,949/share price, which
      // is absurd; whole dollars implies ~$73.95/share, a real price for
      // that stock on that date). No conversion needed here.
      value: Math.round(agg.valueUsd),
      unit: "usd",
    });
  }
  return points;
}

async function processZip(zipUrl: string): Promise<number> {
  const dir = await mkdtemp(path.join(tmpdir(), "sec13f-"));
  const zipPath = path.join(dir, "form13f.zip");
  try {
    console.log(`  13F: downloading ${zipUrl}`);
    await downloadToTempFile(zipUrl, zipPath);

    const sectorMap = await buildSectorCusipMap();
    const periods = await readSubmissionPeriods(zipPath);
    console.log(`  13F: ${periods.size} original 13F-HR filings in this window`);

    const bySectorQuarter = await aggregateInfotable(zipPath, sectorMap, periods);
    const points = toDataPoints(bySectorQuarter);
    await writeDataPoints(points);
    return points.length;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Latest available quarter only -- the manual, workflow_dispatch-triggered steady state. */
export async function fetchSec13f(): Promise<number> {
  const zips = await listAvailableZips();
  if (zips.length === 0) {
    throw new Error("No 13F ZIP links found on the SEC index page — page structure may have changed");
  }
  zips.sort((a, b) => b.sortKey - a.sortKey);
  return processZip(zips[0].url);
}

const BACKFILL_QUARTERS = 4; // ~1 year / 3 QoQ deltas -- each ZIP is ~100MB, deliberately smaller than SSGA's 5yr depth

/** Walks the index page's historical links, processing the most recent BACKFILL_QUARTERS. */
export async function fetchSec13fBackfill(): Promise<number> {
  const zips = await listAvailableZips();
  zips.sort((a, b) => b.sortKey - a.sortKey);
  const toProcess = zips.slice(0, BACKFILL_QUARTERS);

  let total = 0;
  for (const zip of toProcess) {
    total += await processZip(zip.url);
  }
  return total;
}
