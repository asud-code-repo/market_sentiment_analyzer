// EDGAR fund-filing watch for the deployment-instrument registry
// (crash-check-rules.md "Deployment Instrument Selection"). On demand only —
// run from the portfolio review — and local: instrument tickers never leave
// this machine except as EDGAR queries.
//
// Why it's more than a keyword search: a fund trust files one 497 covering
// dozens of funds, and annual SAIs/prospectuses contain "merger",
// "liquidation", "reorganization" as boilerplate (confirmed 2026-11-05 on a
// real SAI). So a hit only becomes an event when (1) the filing header lists
// this fund's series id and (2) the document is a short supplement/sticker
// containing a specific event phrase. Everything else is counted as routine.
//
// Collective trusts and grantor trusts (no 1940-Act series, no 497s) can't be
// watched here and are listed for the manual quarterly check instead.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { load, dump } from "js-yaml";
import { deref, instrumentIds, type FilingEventRef, type Instrument, type Registry } from "./instruments.js";

// Specific phrases only — single words match boilerplate. "fee" is narrowed
// to phrases that indicate a change rather than a fee table.
const STRUCTURAL_PHRASES = [
  "plan of liquidation",
  "will be liquidated",
  "liquidation of the fund",
  "agreement and plan of reorganization",
  "plan of reorganization",
  "will be reorganized",
  "proposed reorganization",
  "proposed merger",
  "will merge",
  "closed to new investors",
  "closed to new investments",
  "closed to new accounts",
  "will close to new",
];
// Fee and manager changes: a review flag only, never a readiness change.
// Only matched inside a confirmed supplement (see isSupplement), where a
// "portfolio manager" mention signals a change rather than the standing
// "Portfolio Managers" section every summary prospectus has.
const FEE_OR_MANAGER_PHRASES = [
  "fee waiver",
  "expense limitation",
  "management fee",
  "advisory fee",
  "portfolio manager",
  "will retire",
  "no longer serve",
  "subadvis",
  "sub-advis",
];
const SEARCH_TERMS = ["merger", "reorganization", "liquidation", "closed", "fee"];

// Supplements ("stickers") are short and say so up front ("Supplement dated
// ... to the Prospectus"). Summary prospectuses "as supplemented on ..." and
// SAIs are routine annual paperwork and don't qualify.
const MAX_SUPPLEMENT_CHARS = 60_000;
const SUPPLEMENT_HEAD = /supplement dated|supplement to the (summary )?prospectus|prospectus supplement/;

export function isSupplement(text: string): boolean {
  return text.length <= MAX_SUPPLEMENT_CHARS && SUPPLEMENT_HEAD.test(text.slice(0, 800).toLowerCase());
}

export interface FilingEvent extends FilingEventRef {
  slot: string;
  which: "primary" | "backup";
  form: string;
  series_id: string;
  reviewed: boolean;
  review_note?: string;
}

export interface FilingWatchResult {
  checked_at: string;
  lookback_days: number;
  events: FilingEvent[];
  routine_filings_skipped: number; // keyword hits that were SAIs/prospectuses or other series
  other_series_same_trust: { instrument: string; series_names: string[] }[];
  manual_check: { slot: string; which: string; name: string; reason: string }[];
  errors: string[];
}

// --- Pure helpers (tested) --------------------------------------------------

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#8217;|&rsquo;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function seriesInHeader(header: string): { id: string; name: string }[] {
  const out: { id: string; name: string }[] = [];
  const re = /<SERIES-ID>(S\d+)\s*<SERIES-NAME>([^\n<]+)/g;
  for (const m of header.matchAll(re)) out.push({ id: m[1], name: m[2].trim() });
  return out;
}

export function classifyDocument(text: string): {
  kind: "structural" | "fee_or_manager" | "routine";
  phrases: string[];
} {
  if (!isSupplement(text)) return { kind: "routine", phrases: [] };
  const lower = text.toLowerCase();
  const structural = STRUCTURAL_PHRASES.filter((p) => lower.includes(p));
  if (structural.length) return { kind: "structural", phrases: structural };
  const fee = FEE_OR_MANAGER_PHRASES.filter((p) => lower.includes(p));
  if (fee.length) return { kind: "fee_or_manager", phrases: fee };
  return { kind: "routine", phrases: [] };
}

/** Unreviewed events, in the shape readiness grading consumes. */
export function unreviewed(events: FilingEvent[]): FilingEventRef[] {
  return events.filter((e) => !e.reviewed);
}

// --- Local cache (local_state/fund_filing_events.yaml) ----------------------

function cachePath(): string {
  const explicit = process.env.FUND_FILING_EVENTS_PATH;
  if (explicit) return explicit;
  const portfolio = process.env.PORTFOLIO_PATH;
  if (!portfolio) throw new Error("Neither FUND_FILING_EVENTS_PATH nor PORTFOLIO_PATH is set");
  return join(dirname(portfolio), "fund_filing_events.yaml");
}

export function readFilingCache(): FilingEvent[] {
  const path = cachePath();
  if (!existsSync(path)) return [];
  const raw = load(readFileSync(path, "utf-8")) as { events?: FilingEvent[] } | null;
  return raw?.events ?? [];
}

function writeFilingCache(events: FilingEvent[], checkedAt: string): void {
  const header =
    "# Local-only, gitignored. Written by check_fund_filings. Set reviewed: true (or use\n" +
    "# acknowledge_fund_filing) once an event has been looked at; unreviewed structural\n" +
    "# events keep the instrument's readiness at AMBER.\n";
  writeFileSync(cachePath(), header + dump({ checked_at: checkedAt, events }, { noRefs: true, lineWidth: 140 }), "utf-8");
}

export function acknowledgeFiling(url: string, note: string): FilingEvent | null {
  const events = readFilingCache();
  const ev = events.find((e) => e.url === url);
  if (!ev) return null;
  ev.reviewed = true;
  ev.review_note = note;
  const raw = existsSync(cachePath()) ? (load(readFileSync(cachePath(), "utf-8")) as { checked_at?: string }) : {};
  writeFilingCache(events, raw?.checked_at ?? new Date().toISOString());
  return ev;
}

// --- EDGAR I/O ----------------------------------------------------------------

// SEC requires a descriptive User-Agent with contact info. Same env var as
// ingestion's secForm4.ts; never hardcode a personal email (public repo).
const CONTACT = process.env.SEC_EDGAR_CONTACT_EMAIL ?? "no-contact-configured@example.com";
const USER_AGENT = `market-sentiment-analyzer ${CONTACT}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function secGet(url: string): Promise<string> {
  let last = "";
  for (const backoff of [0, 1000, 3000, 8000]) {
    await sleep(150 + backoff); // stay well under SEC's 10 req/s; back off on throttling
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    if (res.ok) return res.text();
    last = `HTTP ${res.status} for ${url}`;
    if (res.status !== 429 && res.status < 500) break;
  }
  throw new Error(last);
}

interface TickerRow {
  cik: number;
  seriesId: string;
}

async function loadFundTickerMap(): Promise<Map<string, TickerRow>> {
  const body = JSON.parse(await secGet("https://www.sec.gov/files/company_tickers_mf.json")) as {
    fields: string[];
    data: (string | number)[][];
  };
  const [ci, si, yi] = ["cik", "seriesId", "symbol"].map((f) => body.fields.indexOf(f));
  const map = new Map<string, TickerRow>();
  for (const row of body.data) map.set(String(row[yi]).toUpperCase(), { cik: Number(row[ci]), seriesId: String(row[si]) });
  return map;
}

interface SearchHit {
  adsh: string;
  file: string;
  form: string;
  filed: string;
}

async function searchTrust(cik: number, start: string, end: string): Promise<SearchHit[]> {
  const q = encodeURIComponent(SEARCH_TERMS.map((t) => `"${t}"`).join(" OR "));
  const url =
    `https://efts.sec.gov/LATEST/search-index?q=${q}&forms=497,497K` +
    `&ciks=${String(cik).padStart(10, "0")}&startdt=${start}&enddt=${end}`;
  const body = JSON.parse(await secGet(url)) as {
    hits: { hits: { _id: string; _source: { form: string; file_date: string } }[] };
  };
  return body.hits.hits.map((h) => {
    const [adsh, file] = h._id.split(":");
    return { adsh, file, form: h._source.form, filed: h._source.file_date };
  });
}

interface Target {
  slot: string;
  which: "primary" | "backup";
  inst: Instrument;
  ids: string[];
  cik: number;
  seriesId: string;
}

export async function checkFundFilings(reg: Registry, today: Date, lookbackDays = 100): Promise<FilingWatchResult> {
  const end = today.toISOString().slice(0, 10);
  const start = new Date(today.getTime() - lookbackDays * 86_400_000).toISOString().slice(0, 10);
  const result: FilingWatchResult = {
    checked_at: today.toISOString(),
    lookback_days: lookbackDays,
    events: [],
    routine_filings_skipped: 0,
    other_series_same_trust: [],
    manual_check: [],
    errors: [],
  };

  const tickerMap = await loadFundTickerMap();
  const targets: Target[] = [];
  const seen = new Set<string>();
  for (const [slot, def] of Object.entries(reg.slots)) {
    for (const which of ["primary", "backup"] as const) {
      // A ref'd backup is the same instrument as the slot it points to —
      // watched there, so it isn't reported once per referencing slot.
      if ("ref" in (def[which] as object)) continue;
      const inst = deref(def[which], reg);
      if (inst.route === "none" || inst.vehicle === "stock") continue; // single names: phase 2 thesis gates
      const lookup = inst.proxy_ticker ?? inst.ticker ?? null;
      const row = lookup ? tickerMap.get(lookup.toUpperCase()) : undefined;
      if (!row) {
        result.manual_check.push({
          slot,
          which,
          name: inst.plan_name ?? inst.name,
          reason: lookup
            ? `${lookup} has no 1940-Act fund series (e.g. grantor trust) — check issuer notices / 8-Ks by hand`
            : "no public ticker (collective trust) — check plan notices by hand",
        });
        continue;
      }
      const key = `${slot}:${which}`;
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push({ slot, which, inst, ids: instrumentIds(inst), ...row });
    }
  }

  // One search per trust, then header + document only for candidate filings.
  const byCik = new Map<number, Target[]>();
  for (const t of targets) byCik.set(t.cik, [...(byCik.get(t.cik) ?? []), t]);
  const prior = new Map(readFilingCache().map((e) => [`${e.url}|${e.slot}|${e.which}`, e]));

  for (const [cik, ts] of byCik) {
    let hits: SearchHit[];
    try {
      hits = await searchTrust(cik, start, end);
    } catch (err) {
      result.errors.push(`EDGAR search failed for CIK ${cik}: ${(err as Error).message}`);
      continue;
    }
    for (const hit of [...new Map(hits.map((h) => [h.adsh, h])).values()]) {
      const base = `https://www.sec.gov/Archives/edgar/data/${cik}/${hit.adsh.replace(/-/g, "")}`;
      let series: { id: string; name: string }[];
      try {
        series = seriesInHeader(await secGet(`${base}/${hit.adsh}-index-headers.html`));
      } catch (err) {
        result.errors.push(`Header fetch failed for ${hit.adsh}: ${(err as Error).message}`);
        continue;
      }
      const matched = ts.filter((t) => series.some((s) => s.id === t.seriesId));
      if (!matched.length) {
        result.routine_filings_skipped++;
        for (const t of ts) {
          const label = t.inst.ticker ?? t.inst.proxy_ticker ?? t.inst.name;
          const entry = result.other_series_same_trust.find((o) => o.instrument === label);
          const names = series.map((s) => s.name);
          if (entry) entry.series_names = [...new Set([...entry.series_names, ...names])].slice(0, 10);
          else result.other_series_same_trust.push({ instrument: label, series_names: names.slice(0, 10) });
        }
        continue;
      }
      const url = `${base}/${hit.file}`;
      let cls: ReturnType<typeof classifyDocument>;
      try {
        cls = classifyDocument(htmlToText(await secGet(url)));
      } catch (err) {
        result.errors.push(`Document fetch failed for ${url}: ${(err as Error).message}`);
        continue;
      }
      if (cls.kind === "routine") {
        result.routine_filings_skipped++;
        continue;
      }
      for (const t of matched) {
        const old = prior.get(`${url}|${t.slot}|${t.which}`);
        result.events.push({
          instrument_ids: t.ids,
          slot: t.slot,
          which: t.which,
          kind: cls.kind,
          form: hit.form,
          filed: hit.filed,
          series_id: t.seriesId,
          phrases: cls.phrases,
          url,
          reviewed: old?.reviewed ?? false,
          ...(old?.review_note ? { review_note: old.review_note } : {}),
        });
      }
    }
  }

  // Keep older events that fell outside this lookback — reviewed ones as
  // history, unreviewed ones because they still need a look (aging out of
  // the window must not silently clear a readiness downgrade).
  const current = new Set(result.events.map((e) => `${e.url}|${e.slot}|${e.which}`));
  const carried = [...prior.entries()].filter(([k]) => !current.has(k)).map(([, e]) => e);
  writeFilingCache([...result.events, ...carried], result.checked_at);
  return result;
}
