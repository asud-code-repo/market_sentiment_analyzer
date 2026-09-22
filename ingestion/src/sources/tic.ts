import type { DataPoint } from "../lib/supabase.js";

// Treasury International Capital (TIC) System -- Table 5, "Major Foreign
// Holders of Treasury Securities". Added 2026-09-22 (external review, and
// the same "who's still buying the bonds" question the original fiscal-
// dominance discussion raised). Verified free: a stable tab-delimited .txt
// URL, published monthly, "holdings at end of time period." Not a FRED
// series (Treasury publishes this directly, not via FRED), so this is a
// bespoke parser rather than fred.ts's generic loop -- same pattern as
// gpr.ts for the same reason (a real free source that isn't FRED-shaped).
//
// The file always carries a trailing ~13 months of columns (not full
// history) -- there's a separate MFH-history archive for deeper back data,
// not pulled here since 13 months is already enough to be useful and this
// keeps the parser simple; deeper history is a candidate for a dedicated
// follow-up if the trend view ever needs more than a year.
const TIC_URL = "https://ticdata.treasury.gov/resource-center/data-chart-center/tic/Documents/slt_table5.txt";

// "2026-07" -> "2026-07-31" (last calendar day of that month) -- matches
// the file's own "Holdings at end of time period" framing. Day 0 of the
// *next* month is the standard trick for "last day of this month".
function monthLabelToIsoDate(label: string): string | null {
  const match = /^(\d{4})-(\d{2})$/.exec(label.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const lastDay = new Date(Date.UTC(year, month, 0));
  return lastDay.toISOString().slice(0, 10);
}

function parseRow(line: string): string[] {
  return line.split("\t").map((cell) => cell.trim());
}

export async function fetchTic(): Promise<DataPoint[]> {
  const res = await fetch(TIC_URL);
  if (!res.ok) {
    throw new Error(`TIC fetch failed: HTTP ${res.status}`);
  }
  const text = await res.text();
  const lines = text.split("\n").filter((l) => l.trim().length > 0);

  const headerLine = lines.find((l) => l.startsWith("Country"));
  if (!headerLine) {
    throw new Error("TIC file format changed -- no line starting with \"Country\" found");
  }
  const header = parseRow(headerLine);
  const monthCols = header.slice(1).map((label, i) => ({ label, colIndex: i + 1 })).filter((c) => c.label !== "");

  const grandTotalLine = lines.find((l) => l.startsWith("Grand Total"));
  const foreignOfficialLine = lines.find((l) => l.startsWith("Of Which: Foreign Official") && !l.startsWith("Of Which: Foreign Official Treasury Bills"));
  if (!grandTotalLine || !foreignOfficialLine) {
    throw new Error("TIC file format changed -- expected \"Grand Total\" and \"Of Which: Foreign Official\" rows");
  }
  const grandTotalRow = parseRow(grandTotalLine);
  const foreignOfficialRow = parseRow(foreignOfficialLine);

  const points: DataPoint[] = [];
  for (const { label, colIndex } of monthCols) {
    const isoDate = monthLabelToIsoDate(label);
    if (!isoDate) continue;

    const totalValue = Number(grandTotalRow[colIndex]);
    if (Number.isFinite(totalValue)) {
      points.push({
        series_id: "TIC_FOREIGN_HOLDINGS_TOTAL",
        source: "TREASURY_TIC",
        source_series_code: "slt_table5_grand_total",
        observation_date: isoDate,
        value: totalValue,
        unit: "usd_billions",
        raw_payload: { month_label: label, row: "Grand Total" },
      });
    }

    const officialValue = Number(foreignOfficialRow[colIndex]);
    if (Number.isFinite(officialValue)) {
      points.push({
        series_id: "TIC_FOREIGN_OFFICIAL_HOLDINGS",
        source: "TREASURY_TIC",
        source_series_code: "slt_table5_foreign_official",
        observation_date: isoDate,
        value: officialValue,
        unit: "usd_billions",
        raw_payload: { month_label: label, row: "Of Which: Foreign Official" },
      });
    }
  }
  return points;
}
