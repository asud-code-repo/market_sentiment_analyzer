import { test } from "node:test";
import assert from "node:assert/strict";
import { decideWaveAlert, INITIAL_STATE, QUIET_DATES_TO_REARM, waveAlertMessage, type WaveAlertState, type WaveLevel } from "./waveAlert.js";

function replay(levels: WaveLevel[]): boolean[] {
  let s: WaveAlertState = INITIAL_STATE;
  return levels.map((w, i) => {
    const r = decideWaveAlert(s, w, `2026-01-${String(i + 1).padStart(2, "0")}`);
    s = r.next;
    return r.notify;
  });
}

test("alerts when the level rises, never while it holds", () => {
  assert.deepEqual(replay(["NONE", "WAVE_1", "WAVE_1", "WAVE_2", "WAVE_2", "WAVE_3"]), [false, true, false, true, false, true]);
});

test("a dip and return to the same level stays quiet", () => {
  assert.deepEqual(replay(["WAVE_2", "WAVE_1", "NONE", "WAVE_2", "WAVE_1"]), [true, false, false, false, false]);
});

test("re-arms only after enough quiet dates", () => {
  const quiet = Array<WaveLevel>(QUIET_DATES_TO_REARM).fill("NONE");
  assert.deepEqual(replay(["WAVE_1", ...quiet, "WAVE_1"]).filter(Boolean).length, 2);
  const short = Array<WaveLevel>(QUIET_DATES_TO_REARM - 1).fill("NONE");
  assert.deepEqual(replay(["WAVE_1", ...short, "WAVE_1"]).filter(Boolean).length, 1);
});

test("activity resets the quiet count", () => {
  const half = Array<WaveLevel>(6).fill("NONE");
  assert.equal(replay(["WAVE_1", ...half, "WAVE_1", ...half, "WAVE_1"]).filter(Boolean).length, 1);
});

test("the same observation date counts once (runs twice a day)", () => {
  let s = decideWaveAlert(INITIAL_STATE, "WAVE_1", "2026-01-01").next;
  for (let i = 0; i < QUIET_DATES_TO_REARM + 5; i++) s = decideWaveAlert(s, "NONE", "2026-01-02").next;
  assert.equal(s.last_alerted_level, "WAVE_1");
  assert.equal(decideWaveAlert(s, "WAVE_1", "2026-01-03").notify, false);
});

test("no observation date: no change", () => {
  const r = decideWaveAlert(INITIAL_STATE, "WAVE_3", null);
  assert.equal(r.notify, false);
  assert.deepEqual(r.next, INITIAL_STATE);
});

test("message carries no numbers beyond the 6-indicator count", () => {
  const m = waveAlertMessage("WAVE_2", "SLOW_BEAR", false, 1);
  assert.equal(m.title, "Wave 2 trigger hit");
  assert.match(m.body, /slow bear/);
  assert.match(m.body, /not met \(1 of 6 confirmed RED\), information only/);
  assert.doesNotMatch(m.body, /\$|%/);
});
