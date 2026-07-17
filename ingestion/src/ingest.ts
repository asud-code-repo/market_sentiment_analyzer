import { writeDataPoints, getLatestValue, type DataPoint } from "./lib/supabase.js";
import { checkPlausibility } from "./lib/plausibility.js";
import { fetchFred } from "./sources/fred.js";
import { fetchEia } from "./sources/eia.js";
import { fetchCboe } from "./sources/cboe.js";
import { fetchPolymarket } from "./sources/polymarket.js";
import { fetchMassive } from "./sources/massive.js";

interface SourceResult {
  name: string;
  required: boolean;
  points?: DataPoint[];
  error?: Error;
}

async function runSource(
  name: string,
  required: boolean,
  fn: () => Promise<DataPoint[]>,
): Promise<SourceResult> {
  try {
    const points = await fn();
    return { name, required, points };
  } catch (err) {
    return { name, required, error: err instanceof Error ? err : new Error(String(err)) };
  }
}

async function main() {
  const results = await Promise.all([
    runSource("FRED", true, fetchFred),
    runSource("EIA", true, fetchEia),
    // CBOE is best-effort, not required: it's supplementary sentiment data,
    // not one of the 6 canonical crash indicators, and its only known public
    // CSV source turned out to be a frozen 2019 archive (see cboe.ts). Don't
    // fail the whole run — and thus send a false-alarm email every day —
    // over a source with no known live replacement yet.
    runSource("CBOE", false, fetchCboe),
    runSource("Polymarket", false, fetchPolymarket),
    // Best-effort like CBOE/Polymarket: watchlist ticker prices are
    // supplementary to the crash-check core (not one of the 6 gating
    // indicators), and a free-tier data source can be flaky/rate-limited.
    runSource("Massive", false, fetchMassive),
  ]);

  const requiredFailures = results.filter((r) => r.error && r.required);
  const optionalFailures = results.filter((r) => r.error && !r.required);
  const successes = results.filter((r) => r.points);

  const allPoints = successes.flatMap((r) => r.points ?? []);

  // Data-noise guard (see lib/plausibility.ts): the Signal Tiering
  // confirmation rule protects against a single volatile day authorizing a
  // wave, but not against a bad print sitting in data_points for 2+
  // ingestion dates confirming itself. Quarantined points are skipped
  // (never written) rather than written-but-flagged, so nothing downstream
  // needs to know this check exists to stay correct.
  const plausiblePoints: DataPoint[] = [];
  const quarantined: string[] = [];
  for (const point of allPoints) {
    const previousValue = point.series_id === "SP500" ? await getLatestValue("SP500") : undefined;
    const result = checkPlausibility(point, previousValue);
    if (result.ok) {
      plausiblePoints.push(point);
    } else {
      quarantined.push(result.reason ?? `${point.series_id}=${point.value} failed plausibility check`);
    }
  }

  if (quarantined.length > 0) {
    console.error(`${quarantined.length} data point(s) quarantined (not written) — implausible value, check the source manually:`);
    for (const reason of quarantined) {
      console.error(`  - ${reason}`);
    }
  }

  if (plausiblePoints.length > 0) {
    await writeDataPoints(plausiblePoints);
    console.log(`Wrote ${plausiblePoints.length} data points from: ${successes.map((r) => r.name).join(", ")}`);
  }

  if (optionalFailures.length > 0) {
    console.warn(`${optionalFailures.length} optional source(s) skipped (not failing the run):`);
    for (const f of optionalFailures) {
      console.warn(`  - ${f.name}: ${f.error?.message}`);
    }
  }

  if (requiredFailures.length > 0) {
    console.error(`${requiredFailures.length} required source(s) failed:`);
    for (const f of requiredFailures) {
      console.error(`  - ${f.name}: ${f.error?.message}`);
    }
    // Fail loudly per the build spec: a required-source outage must not be
    // masked by a partially-successful run. GitHub Actions surfaces a
    // non-zero exit as a failed workflow run + notification.
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Ingestion run crashed:", err);
  process.exit(1);
});
