// Institutional 13F tilt per sector, relative to the average sector.
//
// Input is each sector's `{TICKER}_13F_NET_BUYING_PCT` for one quarter:
// price-neutral net buying of the sector's stocks by institutions that
// filed 13Fs in both quarters (ingestion/src/sources/sec13f.ts). Even with
// price and filer coverage removed, all sectors tend to move together in a
// given quarter (index funds growing, institutions buying equities from
// non-filers), and that shared move isn't rotation. Subtracting the
// average across sectors leaves only the tilt: which sectors institutions
// bought MORE of than the rest.
//
// Pure, no Supabase -- unit-tested in institutionalTilt.test.ts.
// Mirrored in dashboard_site/index.html (institutionalTilt); change both.

export type InstitutionalRead = "tilting_toward" | "tilting_away" | "in_line";

// Within +/-1 point of the average reads "in line". Uncalibrated: a
// readability band, not a tested significance threshold.
export const TILT_BAND_PTS = 1;

export interface SectorTilt {
  vsAvgPts: number;
  read: InstitutionalRead;
}

export function institutionalTilt(netBuyingPct: Map<string, number>): Map<string, SectorTilt> {
  const out = new Map<string, SectorTilt>();
  if (netBuyingPct.size < 2) return out; // an average of one sector says nothing
  const values = [...netBuyingPct.values()];
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  for (const [ticker, pct] of netBuyingPct) {
    const vsAvgPts = Math.round((pct - avg) * 100) / 100;
    const read: InstitutionalRead =
      vsAvgPts > TILT_BAND_PTS ? "tilting_toward" : vsAvgPts < -TILT_BAND_PTS ? "tilting_away" : "in_line";
    out.set(ticker, { vsAvgPts, read });
  }
  return out;
}
