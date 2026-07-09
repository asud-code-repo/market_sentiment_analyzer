import { writeDataPoints, type DataPoint } from "./lib/supabase.js";
import { fetchFred } from "./sources/fred.js";
import { fetchEia } from "./sources/eia.js";
import { fetchCboe } from "./sources/cboe.js";
import { fetchPolymarket } from "./sources/polymarket.js";

interface SourceResult {
  name: string;
  points?: DataPoint[];
  error?: Error;
}

async function runSource(name: string, fn: () => Promise<DataPoint[]>): Promise<SourceResult> {
  try {
    const points = await fn();
    return { name, points };
  } catch (err) {
    return { name, error: err instanceof Error ? err : new Error(String(err)) };
  }
}

async function main() {
  const results = await Promise.all([
    runSource("FRED", fetchFred),
    runSource("EIA", fetchEia),
    runSource("CBOE", fetchCboe),
    runSource("Polymarket", fetchPolymarket),
  ]);

  const failures = results.filter((r) => r.error);
  const successes = results.filter((r) => r.points);

  const allPoints = successes.flatMap((r) => r.points ?? []);
  if (allPoints.length > 0) {
    await writeDataPoints(allPoints);
    console.log(`Wrote ${allPoints.length} data points from: ${successes.map((r) => r.name).join(", ")}`);
  }

  if (failures.length > 0) {
    console.error(`${failures.length} source(s) failed:`);
    for (const f of failures) {
      console.error(`  - ${f.name}: ${f.error?.message}`);
    }
    // Fail loudly per the build spec: a source outage must not be masked by
    // a partially-successful run. GitHub Actions surfaces a non-zero exit
    // as a failed workflow run + notification.
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Ingestion run crashed:", err);
  process.exit(1);
});
