// Local wave-trigger push alert. Run by Task Scheduler after each ingest:
//   npx tsx src/scripts/waveAlert.ts            check and push if the wave level rose
//   npx tsx src/scripts/waveAlert.ts --dry-run  print the decision; no push, no state change
//   npx tsx src/scripts/waveAlert.ts --test     send a test push only
// Needs the MCP server's environment (Supabase, PORTFOLIO_PATH/POLICY_PATH) plus NTFY_TOPIC.
// State: wave_alert_state.json next to PORTFOLIO_PATH (local, gitignored).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { currentWaveStatus, getRecentCrashChecks } from "../lib/supabase.js";
import { decideWaveAlert, INITIAL_STATE, waveAlertMessage, type WaveAlertState, type WaveLevel } from "../lib/waveAlert.js";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");

async function push(title: string, body: string, priority = "high"): Promise<void> {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) throw new Error("NTFY_TOPIC is not set");
  const res = await fetch(`https://ntfy.sh/${topic}`, {
    method: "POST",
    headers: { Title: title, Priority: priority, Tags: "rotating_light" },
    body,
  });
  if (!res.ok) throw new Error(`ntfy push failed (${res.status})`);
}

function statePath(): string {
  const portfolio = process.env.PORTFOLIO_PATH;
  if (!portfolio) throw new Error("PORTFOLIO_PATH is not set");
  return join(dirname(portfolio), "wave_alert_state.json");
}

async function main(): Promise<void> {
  const stamp = new Date().toISOString();
  if (args.has("--test")) {
    await push("Wave alert test", "Test: the wave-trigger alert is set up on this computer.", "default");
    console.log(`${stamp} test push sent`);
    return;
  }
  const path = statePath();
  const state: WaveAlertState = existsSync(path) ? JSON.parse(readFileSync(path, "utf-8")) : INITIAL_STATE;
  const status = await currentWaveStatus();
  const [latest] = await getRecentCrashChecks(1);
  const wave = (status.wave_active ?? "NONE") as WaveLevel;
  const { notify, next } = decideWaveAlert(state, wave, status.as_of_observation_date);
  const line = `${stamp} obs=${status.as_of_observation_date} wave=${wave} last_alerted=${state.last_alerted_level} notify=${notify}${dryRun ? " (dry run)" : ""}`;
  if (dryRun) {
    console.log(line);
    return;
  }
  if (notify) {
    const m = waveAlertMessage(wave, status.wave_active_reason, latest?.wave_authorized ?? null, latest?.confirmed_red_count ?? null);
    await push(m.title, m.body); // throws before the state is saved, so a failed push retries next run
  }
  writeFileSync(path, JSON.stringify(next, null, 2) + "\n");
  console.log(line);
}

main().catch((err) => {
  console.error(`${new Date().toISOString()} wave alert failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
