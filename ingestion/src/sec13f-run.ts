import { deleteDataPointsBySource } from "./lib/supabase.js";
import { fetchSec13f, fetchSec13fBackfill } from "./sources/sec13f.js";

// CLI entry for sec13f.ts -- NOT part of ingest.ts/backfill.ts (see
// sec13f.ts's own doc comment for why: quarterly cadence, large batch job,
// manual workflow_dispatch trigger via .github/workflows/sec13f.yml).
// `--backfill` processes the most recent 4 quarters instead of just the
// latest one. `--clean` deletes all existing SEC_13F data_points first --
// needed once (2026-10-02) to purge a since-fixed bug's bogus historical
// rows; a plain re-run's upsert corrects real quarters but can't remove
// rows it no longer writes. `--dry-run` downloads and computes everything
// but writes nothing (and ignores --clean) -- prints each quarter's net
// buying so a change can be checked against real filings first.
async function main() {
  const dryRun = process.argv.includes("--dry-run");
  if (dryRun) console.log("13F: DRY RUN -- nothing will be written or deleted.");
  if (process.argv.includes("--clean") && !dryRun) {
    console.log("13F: deleting existing SEC_13F data_points before reprocessing...");
    await deleteDataPointsBySource("SEC_13F");
  }

  const backfill = process.argv.includes("--backfill");
  if (backfill) {
    console.log("13F backfill: processing the most recent 4 quarters...");
    const count = await fetchSec13fBackfill({ dryRun });
    console.log(`13F backfill complete: ${dryRun ? "computed" : "wrote"} ${count} data_points row(s).`);
  } else {
    console.log("13F: processing the latest available quarter...");
    const count = await fetchSec13f({ dryRun });
    console.log(`13F ingest complete: ${dryRun ? "computed" : "wrote"} ${count} data_points row(s).`);
  }
}

main().catch((err) => {
  console.error("13F run crashed:", err);
  process.exit(1);
});
