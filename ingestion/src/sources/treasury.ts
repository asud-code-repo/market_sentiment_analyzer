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
