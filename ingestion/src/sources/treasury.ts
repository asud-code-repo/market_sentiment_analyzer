import type { DataPoint } from "../lib/supabase.js";

// Treasury Fiscal Data API -- "Average Interest Rates on U.S. Treasury
// Securities," monthly. Added 2026-10-02 for the Fiscal Dominance
// checklist's debt-dynamics checks (r - g, debt-stabilizing primary
// balance): the AVERAGE rate the Treasury pays on its outstanding
// marketable debt, which moves slowly as old low-coupon debt rolls into
// current market yields -- a different (and for debt arithmetic, the
// relevant) number from today's marginal DGS2/DGS10 issuance yields. Not
// on FRED; Treasury publishes it directly through a free, keyless JSON API.
//
// "Total Marketable" EXCLUDES TIPS and floating-rate notes (Treasury's own
// published methodology) -- bills, notes and bonds only.
//
// Returns the full history (2001-present, a few hundred monthly rows) on
// every call, same as tic.ts/gpr.ts -- cheap to re-upsert daily, and the
// backfill uses the same function.
const AVG_RATES_URL = "https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v2/accounting/od/avg_interest_rates";

interface AvgRateRow {
  record_date: string;
  security_desc: string;
  avg_interest_rate_amt: string;
}

export async function fetchTreasuryAvgRates(): Promise<DataPoint[]> {
  const url = new URL(AVG_RATES_URL);
  url.searchParams.set("fields", "record_date,security_desc,avg_interest_rate_amt");
  url.searchParams.set("filter", "security_desc:eq:Total Marketable");
  url.searchParams.set("sort", "-record_date");
  url.searchParams.set("page[size]", "10000");

  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`Treasury avg_interest_rates fetch failed: HTTP ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { data?: AvgRateRow[] };
  const rows = body.data ?? [];
  if (rows.length === 0) {
    throw new Error("Treasury avg_interest_rates returned no \"Total Marketable\" rows -- API shape or filter changed");
  }

  const points: DataPoint[] = [];
  for (const row of rows) {
    const value = Number(row.avg_interest_rate_amt);
    if (!Number.isFinite(value) || !/^\d{4}-\d{2}-\d{2}$/.test(row.record_date)) continue;
    points.push({
      series_id: "TREASURY_AVG_RATE_MARKETABLE",
      source: "TREASURY_FISCALDATA",
      source_series_code: "avg_interest_rates:Total Marketable",
      observation_date: row.record_date,
      value,
      unit: "percent",
      raw_payload: row,
    });
  }
  return points;
}

const FISCALDATA_BASE = "https://api.fiscaldata.treasury.gov/services/api/fiscal_service";

async function fetchFiscalData<T>(path: string, params: Record<string, string>): Promise<T[]> {
  const url = new URL(`${FISCALDATA_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("page[size]", "10000");
  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`Treasury ${path} fetch failed: HTTP ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { data?: T[] };
  return body.data ?? [];
}

/** Throws (naming the fields actually returned) when an expected field is
 * missing -- a renamed field must fail loudly, never silently produce a
 * wrong or partial series. Both sources below are best-effort in ingest.ts,
 * so this can't fail the daily run. */
function requireFields(rows: Record<string, unknown>[], fields: string[], source: string): void {
  const sample = rows[0];
  if (!sample) throw new Error(`${source} returned no rows`);
  const missing = fields.filter((f) => !(f in sample));
  if (missing.length > 0) {
    throw new Error(`${source} is missing expected field(s) ${missing.join(", ")} -- API shape changed. Fields returned: ${Object.keys(sample).join(", ")}`);
  }
}

// Treasury Fiscal Data API -- "Treasury Securities Auctions Data"
// (auctions_query). Added 2026-10-02 (external review, round 2): auction
// demand is the timeliest "who is still buying the bonds?" signal --
// TIC holdings (tic.ts) lag ~2 months. Original-issue nominal coupon
// auctions only, for the four benchmark tenors: reopenings (different
// security_term, e.g. "9-Year 10-Month"), TIPS and FRNs (the 2-Year FRN
// shares the "2-Year" term) are excluded so each series compares like with
// like. Per auction, three series keyed by auction_date:
//   - bid-to-cover (bid_to_cover_ratio, as published)
//   - primary-dealer take-down % = primary_dealer_accepted / comp_accepted
//   - indirect-bidder %          = indirect_bidder_accepted / comp_accepted
// (shares of competitive accepted, the usual market convention). Tails need
// the when-issued yield at the auction deadline, which isn't in any free
// source -- not computed.
const AUCTION_TENORS: Record<string, string> = {
  "2-Year": "2Y",
  "5-Year": "5Y",
  "10-Year": "10Y",
  "30-Year": "30Y",
};
const AUCTION_HISTORY_START = "2015-01-01";

type AuctionRow = Record<string, string | null>;

export async function fetchTreasuryAuctions(): Promise<DataPoint[]> {
  const rows = await fetchFiscalData<AuctionRow>("/v1/accounting/od/auctions_query", {
    filter: `auction_date:gte:${AUCTION_HISTORY_START},security_type:in:(Note,Bond)`,
    sort: "-auction_date",
  });
  requireFields(
    rows,
    ["auction_date", "security_term", "reopening", "inflation_index_security", "floating_rate", "bid_to_cover_ratio", "comp_accepted", "primary_dealer_accepted", "indirect_bidder_accepted"],
    "Treasury auctions_query",
  );

  const points: DataPoint[] = [];
  for (const row of rows) {
    const tenor = AUCTION_TENORS[row.security_term ?? ""];
    if (!tenor) continue;
    if (row.reopening === "Yes" || row.inflation_index_security === "Yes" || row.floating_rate === "Yes") continue;
    const date = row.auction_date ?? "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const btc = Number(row.bid_to_cover_ratio);
    const comp = Number(row.comp_accepted);
    const dealer = Number(row.primary_dealer_accepted);
    const indirect = Number(row.indirect_bidder_accepted);
    // Announced-but-not-yet-held auctions come back with null results.
    if (!Number.isFinite(btc) || btc <= 0 || !Number.isFinite(comp) || comp <= 0) continue;

    const base = {
      source: "TREASURY_FISCALDATA",
      source_series_code: `auctions_query:${row.security_term}`,
      observation_date: date,
      raw_payload: { cusip: row.cusip, security_term: row.security_term, bid_to_cover_ratio: row.bid_to_cover_ratio, comp_accepted: row.comp_accepted, primary_dealer_accepted: row.primary_dealer_accepted, indirect_bidder_accepted: row.indirect_bidder_accepted },
    };
    points.push({ ...base, series_id: `AUCTION_${tenor}_BID_TO_COVER`, value: btc, unit: "ratio" });
    if (Number.isFinite(dealer)) points.push({ ...base, series_id: `AUCTION_${tenor}_DEALER_PCT`, value: (dealer / comp) * 100, unit: "percent" });
    if (Number.isFinite(indirect)) points.push({ ...base, series_id: `AUCTION_${tenor}_INDIRECT_PCT`, value: (indirect / comp) * 100, unit: "percent" });
  }
  if (points.length === 0) {
    throw new Error("Treasury auctions_query: no benchmark original-issue coupon auctions parsed -- filter or field values changed");
  }
  return points;
}

// Treasury Fiscal Data API -- Monthly Statement of the Public Debt, table 1
// ("Summary of Treasury Securities Outstanding"). Total marketable debt,
// $ millions, month-end -- the denominator for the Fed's share of
// marketable Treasuries (FRED TREAST / this). Includes TIPS and FRNs, as
// does TREAST.
export async function fetchTreasuryMarketableDebt(): Promise<DataPoint[]> {
  const rows = await fetchFiscalData<AuctionRow>("/v1/debt/mspd/mspd_table_1", {
    filter: "security_class_desc:eq:Total Marketable",
    sort: "-record_date",
  });
  requireFields(rows, ["record_date", "total_mil_amt"], "Treasury mspd_table_1");

  const points: DataPoint[] = [];
  for (const row of rows) {
    const value = Number(row.total_mil_amt);
    const date = row.record_date ?? "";
    if (!Number.isFinite(value) || value <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    points.push({
      series_id: "MSPD_TOTAL_MARKETABLE",
      source: "TREASURY_FISCALDATA",
      source_series_code: "mspd_table_1:Total Marketable",
      observation_date: date,
      value,
      unit: "usd_millions",
      raw_payload: row,
    });
  }
  if (points.length === 0) {
    throw new Error("Treasury mspd_table_1 returned no usable \"Total Marketable\" rows");
  }
  return points;
}
