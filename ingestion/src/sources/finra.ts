import * as XLSX from "xlsx";
import type { DataPoint } from "../lib/supabase.js";

// FINRA margin statistics -- debit balances in customers' securities margin
// accounts, i.e. how much borrowed money is behind long stock positions.
// Added 2026-10-29 alongside the CFTC positioning data. Free, monthly,
// 1997-present (verified live 2026-10-29, data through 2026-09). Units are
// millions of dollars.
//
// The download link lives on FINRA's margin-statistics page; its path
// (".../2021-03/margin-statistics.xlsx") looks stale but the file behind it
// is updated in place every month. Scrape the link from the page first in
// case FINRA ever moves it, fall back to the known path. Full history every
// run (~360 rows), same pattern as gpr.ts -- cheap to re-upsert daily.
const PAGE_URL = "https://www.finra.org/rules-guidance/key-topics/margin-accounts/margin-statistics";
const FALLBACK_FILE_URL = "https://www.finra.org/sites/default/files/2021-03/margin-statistics.xlsx";

async function resolveFileUrl(): Promise<string> {
  try {
    const res = await fetch(PAGE_URL);
    if (res.ok) {
      const match = /href="([^"]*margin-statistics[^"]*\.xlsx)"/i.exec(await res.text());
      if (match) return new URL(match[1], PAGE_URL).toString();
    }
  } catch {
    // Fall through to the known path.
  }
  return FALLBACK_FILE_URL;
}

export async function fetchFinraMargin(): Promise<DataPoint[]> {
  const fileUrl = await resolveFileUrl();
  const res = await fetch(fileUrl);
  if (!res.ok) {
    throw new Error(`FINRA margin statistics fetch failed: HTTP ${res.status} (${fileUrl})`);
  }
  const workbook = XLSX.read(await res.arrayBuffer(), { type: "array" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1 });

  const header = (rows[0] ?? []) as string[];
  const monthCol = header.findIndex((h) => typeof h === "string" && h.trim().toLowerCase() === "year-month");
  const debitCol = header.findIndex((h) => typeof h === "string" && h.toLowerCase().startsWith("debit balances"));
  if (monthCol === -1 || debitCol === -1) {
    throw new Error(`FINRA margin file format changed -- expected "Year-Month" and "Debit Balances..." columns, got: ${header.join(", ")}`);
  }

  const points: DataPoint[] = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const month = row[monthCol];
    const debit = row[debitCol];
    if (typeof month !== "string" || !/^\d{4}-\d{2}$/.test(month.trim()) || typeof debit !== "number") continue;
    points.push({
      series_id: "FINRA_MARGIN_DEBIT_USD_MILLIONS",
      source: "FINRA",
      source_series_code: "margin_debit_balances",
      observation_date: `${month.trim()}-01`,
      value: debit,
      unit: "usd_millions",
    });
  }
  if (points.length === 0) {
    throw new Error("FINRA margin file parsed but contained no data rows");
  }
  return points;
}
