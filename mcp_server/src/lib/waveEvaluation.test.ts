// Run: npm test (node's built-in test runner via tsx -- no test framework dependency).
// Uses the public example policy's illustrative triggers, never the real ones.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { loadPolicy } from "./waveDeployment.js";
import { evaluateCurrentWave, evaluateWaveHistory, fastPanicWave, type WaveInputRow } from "./waveEvaluation.js";

const policy = loadPolicy(fileURLToPath(new URL("../../../local_state/policy.example.yaml", import.meta.url)));
const t = policy.wave_triggers;
const fp = t.fast_panic;
const sb = t.slow_bear;

const row = (date: string, drawdown: number, vix: number, daysSinceLow: number | null, runAt = `${date}T15:00:00Z`): WaveInputRow => ({
  run_at: runAt,
  observation_date: date,
  drawdown_pct: drawdown,
  vix,
  days_since_252d_low: daysSinceLow,
});

test("fast panic: drawdown >= threshold AND VIX strictly above, deepest wave first", () => {
  assert.equal(fastPanicWave(fp.WAVE_1.drawdown_pct_gte - 0.01, 99, t), "NONE");
  assert.equal(fastPanicWave(fp.WAVE_1.drawdown_pct_gte, fp.WAVE_1.vix_gt, t), "NONE"); // VIX not above
  assert.equal(fastPanicWave(fp.WAVE_1.drawdown_pct_gte, fp.WAVE_1.vix_gt + 0.01, t), "WAVE_1");
  // Deep drawdown but VIX only clears Wave 2's bar -> Wave 2, not 3.
  assert.equal(fastPanicWave(fp.WAVE_3.drawdown_pct_gte, fp.WAVE_2.vix_gt + 0.01, t), "WAVE_2");
  assert.equal(fastPanicWave(fp.WAVE_3.drawdown_pct_gte, fp.WAVE_3.vix_gt + 0.01, t), "WAVE_3");
});

test("slow bear needs a fresh low within the window and confirmation on 2 distinct dates", () => {
  const dd = sb.WAVE_2.drawdown_pct_gte;
  const calmVix = 10; // keeps the fast-panic pathway out of it
  // Day 1 at a fresh low: RED but unconfirmed -> no wave yet.
  let s = evaluateCurrentWave([row("2026-01-05", dd, calmVix, 0)], policy, 2);
  assert.equal(s.wave_active, "NONE");
  assert.equal(s.slow_bear.w2?.color, "RED");
  // Same date re-run doesn't count twice.
  s = evaluateCurrentWave([row("2026-01-05", dd, calmVix, 0), row("2026-01-05", dd, calmVix, 0, "2026-01-05T18:00:00Z")], policy, 2);
  assert.equal(s.wave_active, "NONE");
  // Second distinct date, still fresh -> confirmed Wave 2 via SLOW_BEAR.
  s = evaluateCurrentWave([row("2026-01-05", dd, calmVix, 0), row("2026-01-06", dd, calmVix, 1)], policy, 2);
  assert.deepEqual([s.wave_active, s.wave_active_reason], ["WAVE_2", "SLOW_BEAR"]);
  // Low older than the window -> not fresh -> streak breaks.
  s = evaluateCurrentWave(
    [row("2026-01-05", dd, calmVix, 0), row("2026-01-06", dd, calmVix, sb.freshness_window_trading_days + 1)],
    policy,
    2,
  );
  assert.equal(s.wave_active, "NONE");
  // Missing days_since_252d_low counts as not fresh.
  s = evaluateCurrentWave([row("2026-01-05", dd, calmVix, null), row("2026-01-06", dd, calmVix, null)], policy, 2);
  assert.equal(s.wave_active, "NONE");
});

test("the higher wave wins; a tie reports FAST_PANIC", () => {
  const dd3 = Math.max(sb.WAVE_3.drawdown_pct_gte, fp.WAVE_3.drawdown_pct_gte);
  // Slow-bear Wave 3 confirmed while VIX only clears Wave 1's fast-panic bar.
  const rows = [row("2026-02-02", dd3, fp.WAVE_1.vix_gt + 0.5, 0), row("2026-02-03", dd3, fp.WAVE_1.vix_gt + 0.5, 0)];
  let s = evaluateCurrentWave(rows, policy, 2);
  assert.deepEqual([s.wave_active, s.wave_active_reason, s.fast_panic_wave], ["WAVE_3", "SLOW_BEAR", "WAVE_1"]);
  // Same, but VIX now clears Wave 3's fast-panic bar too: tie -> FAST_PANIC.
  const hot = rows.map((r) => ({ ...r, vix: fp.WAVE_3.vix_gt + 1 }));
  s = evaluateCurrentWave(hot, policy, 2);
  assert.deepEqual([s.wave_active, s.wave_active_reason], ["WAVE_3", "FAST_PANIC"]);
});

test("history replay returns one status per row and NONE for an empty history", () => {
  const rows = [row("2026-03-02", 1, 15, 300), row("2026-03-03", 2, 16, 301)];
  assert.equal(evaluateWaveHistory(rows, policy, 2).length, 2);
  assert.equal(evaluateCurrentWave([], policy, 2).wave_active, "NONE");
});
