import { writeDataPoints } from "./lib/supabase.js";
import { fetchFredBackfill } from "./sources/fred.js";
import { fetchAlphaVantageBackfill } from "./sources/alphavantage.js";

// One-time historical backfill for data_points — NOT part of the daily
// ingestion run (see ingest.ts), which only ever needs the latest reading.
// Idempotent: upserts on (series_id, observation_date), safe to re-run.
// Scope is deliberately data_points only — it does NOT backfill crash_checks
// (the rule engine's historical band/color/wave classification), which would
// need a full historical replay of classify.ts and has no source for fields
// like fed_pivot_signal/Warsh classification that only exist as "carried
// forward from the prior row" state.
async function main() {
  console.log("Backfilling FRED series (5yr)...");
  const fredPoints = await fetchFredBackfill();
  console.log(`FRED backfill: ${fredPoints.length} total observations.`);

  console.log("Backfilling watchlist ticker prices (free-tier ceiling: ~100 trading days)...");
  const tickerPoints = await fetchAlphaVantageBackfill();
  console.log(`Alpha Vantage backfill: ${tickerPoints.length} total observations.`);

  const allPoints = [...fredPoints, ...tickerPoints];
  console.log(`Writing ${allPoints.length} data points to Supabase...`);
  await writeDataPoints(allPoints);
  console.log("Backfill complete.");
}

main().catch((err) => {
  console.error("Backfill run crashed:", err);
  process.exit(1);
});
