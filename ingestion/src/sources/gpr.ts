import * as XLSX from "xlsx";
import type { DataPoint } from "../lib/supabase.js";

// Geopolitical Risk (GPR) Index -- Caldara & Iacoviello (Federal Reserve
// Board), a text-parsing tally of geopolitical-tension coverage across 10
// major newspapers. Added 2026-09-22 (external review): verified free,
// actively maintained (data through 2026-08 confirmed live), monthly, and
// not yet tracked anywhere in this system. The published file's "GPR"
// column (the headline index this fetches) runs 1985-present -- the file
// also carries earlier columns (back to 1900) for a differently-sourced
// historical variant, not fetched here.
//
// The published file is legacy binary .xls (OLE2/CFB format, not the
// zip-based .xlsx this repo's existing `exceljs` dependency can read) --
// confirmed by attempting exceljs.xlsx.readFile() first, which fails with
// "Can't find end of central directory: is this a zip file?". `xlsx`
// (SheetJS) handles both formats, but the npm-registry-published version
// (0.18.5 as of this writing) has two unpatched HIGH severity advisories
// (prototype pollution, ReDoS — "No fix available" via `npm audit`, since
// SheetJS stopped pushing security fixes to the npm registry). Installed
// from SheetJS's own CDN instead (see package.json's `xlsx` entry, a pinned
// tarball URL, not a registry version) -- their documented, current
// distribution channel for actually-patched releases. Worth the extra step
// given this parses a file fetched over the network inside a CI pipeline
// that has real secrets in its environment.
const GPR_URL = "https://www.matteoiacoviello.com/gpr_files/data_gpr_export.xls";

// Excel's date epoch is 1899-12-30 (not 1900-01-01 -- the historical
// "1900 is a leap year" bug baked into every spreadsheet program since
// Lotus 1-2-3), and the "month" column is a whole-day serial, always
// landing on the 1st of its month in this file.
function excelSerialToIsoDate(serial: number): string {
  const epoch = Date.UTC(1899, 11, 30);
  return new Date(epoch + serial * 86400000).toISOString().slice(0, 10);
}

export async function fetchGpr(): Promise<DataPoint[]> {
  const res = await fetch(GPR_URL);
  if (!res.ok) {
    throw new Error(`GPR fetch failed: HTTP ${res.status}`);
  }
  const buffer = await res.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1 });

  const header = rows[0] as string[];
  const monthCol = header.indexOf("month");
  const gprCol = header.indexOf("GPR");
  if (monthCol === -1 || gprCol === -1) {
    throw new Error(`GPR file format changed -- expected "month" and "GPR" columns, got: ${header.slice(0, 5).join(", ")}...`);
  }

  const points: DataPoint[] = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const serial = row[monthCol];
    const gprValue = row[gprCol];
    if (typeof serial !== "number" || typeof gprValue !== "number") continue;
    points.push({
      series_id: "GPR_INDEX",
      source: "MATTEO_IACOVIELLO",
      source_series_code: "GPR",
      observation_date: excelSerialToIsoDate(serial),
      value: Math.round(gprValue * 100) / 100,
      unit: "index",
      raw_payload: { month_serial: serial, GPR: gprValue },
    });
  }
  return points;
}
