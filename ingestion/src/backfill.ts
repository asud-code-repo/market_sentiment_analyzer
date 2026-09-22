import { writeDataPoints } from "./lib/supabase.js";
import { fetchFredBackfill } from "./sources/fred.js";
import { fetchMassiveBackfill } from "./sources/massive.js";
import { fetchSsgaBackfill } from "./sources/ssga.js";
import { fetchGpr } from "./sources/gpr.js";
import { fetchTic } from "./sources/tic.js";

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

  console.log("Backfilling watchlist ticker prices (2yr via Massive)...");
  const tickerPoints = await fetchMassiveBackfill();
  console.log(`Massive backfill: ${tickerPoints.length} total observations.`);

  console.log("Backfilling sector-rotation NAV/shares-outstanding (5yr via SSGA)...");
  const ssgaPoints = await fetchSsgaBackfill();
  console.log(`SSGA backfill: ${ssgaPoints.length} total observations.`);

  // No separate backfill variant needed -- fetchGpr/fetchTic already return
  // their full available window on every call (GPR's full 1900-present
  // history, TIC's trailing ~13 months), same function used by the daily
  // ingest job. Isolated try/catch since these are best-effort sources
  // (external sites, not FRED/a Treasury-run API) and a failure here
  // shouldn't lose the FRED/Massive/SSGA points already gathered above.
  let gprPoints: Awaited<ReturnType<typeof fetchGpr>> = [];
  try {
    console.log("Backfilling GPR index (full history)...");
    gprPoints = await fetchGpr();
    console.log(`GPR backfill: ${gprPoints.length} total observations.`);
  } catch (err) {
    console.error(`GPR backfill failed, continuing without it: ${err instanceof Error ? err.message : err}`);
  }

  let ticPoints: Awaited<ReturnType<typeof fetchTic>> = [];
  try {
    console.log("Backfilling TIC foreign holdings (trailing ~13mo)...");
    ticPoints = await fetchTic();
    console.log(`TIC backfill: ${ticPoints.length} total observations.`);
  } catch (err) {
    console.error(`TIC backfill failed, continuing without it: ${err instanceof Error ? err.message : err}`);
  }

  const allPoints = [...fredPoints, ...tickerPoints, ...ssgaPoints, ...gprPoints, ...ticPoints];
  console.log(`Writing ${allPoints.length} data points to Supabase...`);
  await writeDataPoints(allPoints);
  console.log("Backfill complete.");
}

main().catch((err) => {
  console.error("Backfill run crashed:", err);
  process.exit(1);
});
