import { readFileSync, writeFileSync } from "node:fs";
import { load, dump } from "js-yaml";
import type { Wave } from "./waveDeployment.js";

export interface WaveDeploymentState {
  WAVE_1: { executed: boolean; executed_date: string | null };
  WAVE_2: { executed: boolean; executed_date: string | null };
  WAVE_3: { executed: boolean; executed_date: string | null };
}

function waveDeploymentStatePath(): string {
  const path = process.env.WAVE_DEPLOYMENT_STATE_PATH;
  if (!path) {
    throw new Error("WAVE_DEPLOYMENT_STATE_PATH is not set — see mcp_server/.env.example");
  }
  return path;
}

/**
 * Reads local_state/wave_deployment_state.yaml (or wherever
 * WAVE_DEPLOYMENT_STATE_PATH points) — tracks which waves have actually been
 * executed in the brokerage, so get_deployment_plan knows what's still
 * pending vs. already acted on. Same trust boundary as portfolio.ts/
 * watchlist.ts: local-only, never touches Supabase.
 */
export function readWaveDeploymentState(): WaveDeploymentState {
  let raw: string;
  try {
    raw = readFileSync(waveDeploymentStatePath(), "utf-8");
  } catch (err) {
    throw new Error(
      `Could not read wave deployment state file at ${waveDeploymentStatePath()}. Copy ` +
        `local_state/wave_deployment_state.example.yaml to local_state/wave_deployment_state.yaml, ` +
        `or fix WAVE_DEPLOYMENT_STATE_PATH. (${err})`,
    );
  }
  return load(raw) as WaveDeploymentState;
}

/**
 * Marks a wave as executed as of the given date and persists the full state
 * (same full-replacement pattern as writeWatchlist). Called explicitly via
 * the record_wave_deployment tool after the user has actually placed the
 * trades — get_deployment_plan itself never writes this state.
 */
export function recordWaveDeployment(wave: Wave, executedDate: string): WaveDeploymentState {
  const state = readWaveDeploymentState();
  const updated: WaveDeploymentState = {
    ...state,
    [wave]: { executed: true, executed_date: executedDate },
  };
  writeFileSync(waveDeploymentStatePath(), dump(updated, { noRefs: true }), "utf-8");
  return updated;
}
