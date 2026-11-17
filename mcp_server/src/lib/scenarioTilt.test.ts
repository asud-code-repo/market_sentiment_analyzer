// Run: npm test (node's built-in test runner via tsx -- no test framework dependency).
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyTilt, loadScenarioPrior, priorStateOf, scenarioPriorFor, validateTiltReasons, TILTS } from "./scenarioTilt.js";

const file = loadScenarioPrior();

test("reproduces every sample tilt in the frozen release file (same rule as the research repo)", () => {
  for (const s of file.samples) {
    assert.deepEqual(applyTilt(file.prior[s.state].split, s.tilt, file.tilt.step_pts), s.split, `${s.state} ${s.tilt}`);
  }
  for (const s of file.edge_samples) {
    assert.deepEqual(applyTilt(s.prior, s.tilt, file.tilt.step_pts), s.split, `${JSON.stringify(s.prior)} ${s.tilt}`);
  }
});

test("every tilted split is whole numbers, non-negative and sums to 100", () => {
  for (const state of Object.keys(file.prior) as (keyof typeof file.prior)[]) {
    for (const t of TILTS) {
      const s = scenarioPriorFor(state, file).split_by_tilt[t];
      assert.equal(s.bull + s.base + s.bear + s.crash, 100);
      for (const v of Object.values(s)) assert.ok(Number.isInteger(v) && v >= 0);
    }
  }
});

test("higher adds exactly one step to bear + crash, lower removes it (capped at what's there)", () => {
  const p = file.prior.HIGH.split;
  const up = applyTilt(p, "higher", 5), down = applyTilt(p, "lower", 5);
  assert.equal(up.bear + up.crash, p.bear + p.crash + 5);
  assert.equal(down.bear + down.crash, p.bear + p.crash - 5);
  const thin = applyTilt({ bull: 50, base: 48, bear: 2, crash: 0 }, "lower", 5);
  assert.deepEqual(thin, { bull: 51, base: 49, bear: 0, crash: 0 });
});

test("prior state follows the band, with the formula as fallback and 10% drawdown as breached", () => {
  assert.equal(priorStateOf(12, 30, null), "ALREADY_BREACHED");
  assert.equal(priorStateOf(3, 20, "HIGH"), "HIGH");
  assert.equal(priorStateOf(5, 25, null), "HIGH");
  assert.equal(priorStateOf(5, 18, null), "TRANSITIONING");
  assert.equal(priorStateOf(1, 15, null), "LOW");
  assert.equal(priorStateOf(null, 15, null), null);
});

test("tilt reasons: required off in_line, max 3, each must cite a number", () => {
  assert.deepEqual(validateTiltReasons("in_line", []), []);
  assert.equal(validateTiltReasons("higher", []).length, 1);
  assert.deepEqual(validateTiltReasons("higher", ["HY spread widened 40bp in 20 days"]), []);
  assert.equal(validateTiltReasons("lower", ["credit looks calm"]).length, 1);
  assert.equal(validateTiltReasons("higher", ["a 1", "b 2", "c 3", "d 4"]).length, 1);
});
