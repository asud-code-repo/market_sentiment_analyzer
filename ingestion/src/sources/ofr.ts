import type { DataPoint } from "../lib/supabase.js";

// OFR Financial Stress Index (Office of Financial Research, U.S. Treasury),
// added 2026-11-16. Daily, 2000-present, public domain, keyless CSV. Fills
// the gap flagged in the 2026-11-14 external-dashboards review: the two
// stress indexes already tracked (St. Louis Fed STLFSI4, Chicago Fed NFCI)
// are WEEKLY and were 10 days old on Nov 16, while this one had Nov 12.
// Built from 33 market variables (credit spreads, equity valuations,
// funding, safe-asset demand, volatility) across US, other advanced and
// emerging markets. Zero = average stress over its history; positive =
// above average. Shown alongside STLFSI4/NFCI, not replacing them -- a
// different construction, and those two carry their own long records.
//
// Only the headline column is stored. The header is matched by name and a
// missing column throws (optional source in ingest.ts, so a format change
// logs a warning instead of failing the run).
const FSI_URL = "https://www.financialresearch.gov/financial-stress-index/data/fsi.csv";
const HEADLINE = "OFR FSI";

function toPoint(date: string, value: number): DataPoint {
  return {
    series_id: "OFR_FSI",
    source: "OFR",
    source_series_code: HEADLINE,
    observation_date: date,
    value,
    unit: "index",
    raw_payload: { date, [HEADLINE]: value },
  };
}

export function parseOfrFsiCsv(text: string): DataPoint[] {
  const lines = text.trim().split(/\r?\n/);
  const header = (lines[0] ?? "").split(",").map((h) => h.replace(/"/g, "").trim());
  const dateCol = header.indexOf("Date");
  const valueCol = header.indexOf(HEADLINE);
  if (dateCol < 0 || valueCol < 0) {
    throw new Error(`OFR FSI CSV missing "Date" or "${HEADLINE}" column; header was: ${header.join(" | ")}`);
  }
  const points: DataPoint[] = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(",");
    const date = (cells[dateCol] ?? "").trim();
    const value = Number(cells[valueCol]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || cells[valueCol]?.trim() === "" || !Number.isFinite(value)) continue;
    points.push(toPoint(date, value));
  }
  if (points.length === 0) throw new Error("OFR FSI CSV parsed to zero rows");
  return points.sort((a, b) => a.observation_date.localeCompare(b.observation_date));
}

async function fetchAll(): Promise<DataPoint[]> {
  const res = await fetch(FSI_URL);
  if (!res.ok) throw new Error(`OFR FSI fetch failed: HTTP ${res.status}`);
  return parseOfrFsiCsv(await res.text());
}

/** Daily ingest: the trailing ~6 weeks, so a late or revised day is picked up on the next run. */
export async function fetchOfrFsi(): Promise<DataPoint[]> {
  return (await fetchAll()).slice(-30);
}

/** Full 2000-present history (~6,800 rows), for backfill.ts. */
export async function fetchOfrFsiBackfill(): Promise<DataPoint[]> {
  const points = await fetchAll();
  console.log(`  OFR FSI backfill: ${points.length} observations since ${points[0]?.observation_date ?? "n/a"}`);
  return points;
}
