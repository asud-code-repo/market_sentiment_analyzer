import { deleteDataPointsBySource } from "./lib/supabase.js";
import { fetchSec13f, fetchSec13fBackfill } from "./sources/sec13f.js";

// CLI entry for sec13f.ts -- NOT part of ingest.ts/backfill.ts (see
// sec13f.ts's own doc comment for why: quarterly cadence, large batch job,
// manual workflow_dispatch trigger via .github/workflows/sec13f.yml).
// `--backfill` processes the most recent 4 quarters instead of just the
// latest one. `--clean` deletes all existing SEC_13F data_points first --
// needed once (2026-10-02) to purge a since-fixed bug's bogus historical
// rows; a plain re-run's upsert corrects real quarters but can't remove
// rows it no longer writes.
async function main() {
  if (process.argv.includes("--clean")) {
    console.log("13F: deleting existing SEC_13F data_points before reprocessing...");
    await deleteDataPointsBySource("SEC_13F");
  }

  const backfill = process.argv.includes("--backfill");
  if (backfill) {
    console.log("13F backfill: processing the most recent 4 quarters...");
    const count = await fetchSec13fBackfill();
    console.log(`13F backfill complete: wrote ${count} data_points row(s).`);
  } else {
    console.log("13F: processing the latest available quarter...");
    const count = await fetchSec13f();
    console.log(`13F ingest complete: wrote ${count} data_points row(s).`);
  }
}

main().catch((err) => {
  console.error("13F run crashed:", err);
  process.exit(1);
});
