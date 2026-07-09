import type { DataPoint } from "../lib/supabase.js";

// ⚠️ VERIFY BEFORE RELYING ON THIS SOURCE ⚠️
// This CSV URL resolves (HTTP 200, correct column structure: DATE,CALLS,PUTS,
// TOTAL,P/C Ratio) but as of 2026-07-09 its most recent row was dated
// 2019-10-04 — the file appears to be a frozen/discontinued archive, not a
// live daily feed. CBOE seems to have moved current put/call data behind
// https://www.cboe.com/us/options/market_statistics/daily/ , which renders
// client-side (no stable public CSV/JSON endpoint found without an account).
// The staleness guard below turns this into a loud failure instead of
// silently writing a 2019 value as "today's" reading — but you should find
// a current source (or confirm CBOE has one) before depending on this in
// the rule engine.
const TOTAL_PC_URL = "https://cdn.cboe.com/resources/options/volume_and_call_put_ratios/totalpc.csv";
const MAX_STALENESS_DAYS = 5;

function parseMDY(dateStr: string): Date {
  const [m, d, y] = dateStr.trim().split("/").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export async function fetchCboe(): Promise<DataPoint[]> {
  const res = await fetch(TOTAL_PC_URL);
  if (!res.ok) {
    throw new Error(`CBOE put/call CSV request failed: HTTP ${res.status}`);
  }
  const text = await res.text();

  // Layout: disclaimer line, product line, header line, then data rows.
  const lines = text.trim().split("\n").filter((l) => l.trim().length > 0);
  const headerIdx = lines.findIndex((l) => l.toUpperCase().startsWith("DATE,"));
  if (headerIdx === -1 || headerIdx === lines.length - 1) {
    throw new Error("CBOE put/call CSV did not contain the expected header/data rows");
  }

  const lastRow = lines[lines.length - 1].split(",").map((c) => c.trim());
  const [dateStr, , , , ratioStr] = lastRow;
  const obsDate = parseMDY(dateStr);

  const ageDays = (Date.now() - obsDate.getTime()) / (1000 * 60 * 60 * 24);
  if (ageDays > MAX_STALENESS_DAYS) {
    throw new Error(
      `CBOE put/call CSV's latest row is ${Math.floor(ageDays)} days old (${dateStr}) — ` +
        `source appears stale or discontinued. Failing loudly instead of writing a stale value.`,
    );
  }

  return [
    {
      series_id: "CBOE_TOTAL_PC_RATIO",
      source: "CBOE",
      source_series_code: "TOTAL_PC",
      observation_date: toIsoDate(obsDate),
      value: Number(ratioStr),
      unit: "ratio",
      raw_payload: { row: lastRow },
    },
  ];
}
