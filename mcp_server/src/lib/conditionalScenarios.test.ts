// Run: npm test (node's built-in test runner via tsx -- no test framework dependency).
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveConditional, validateSubmitted, dueEvents, type SubmittedEvent, type OpenPrediction } from "./conditionalScenarios.js";

const split = { bull: 20, base: 46, bear: 24, crash: 10 };
// Probability-weighted: bull 0.6*22+0.3*16+0.1*20 = 20.0, base 47.4, bear 23.0, crash 9.6 -> reconciles.
const fomc: SubmittedEvent = {
  event: "Dec 2026 FOMC",
  event_date: "2026-12-09",
  branches: [
    { outcome: "hold", probability: 60, bull: 22, base: 50, bear: 20, crash: 8 },
    { outcome: "hike 25bp", probability: 30, bull: 16, base: 42, bear: 29, crash: 13 },
    { outcome: "cut 25bp", probability: 10, bull: 20, base: 44, bear: 26, crash: 10 },
  ],
};
const open = (e: SubmittedEvent, made_on = "2026-12-08"): OpenPrediction => ({ ...e, made_on, unconditional_at_prediction: split });

test("a valid submission passes; same-day (event_date == today) is allowed, past is not", () => {
  assert.deepEqual(validateSubmitted([fomc], split, "2026-12-08"), []);
  assert.deepEqual(validateSubmitted([fomc], split, "2026-12-09"), []);
  assert.match(validateSubmitted([fomc], split, "2026-12-10").join(" "), /in the past/);
});

test("sums, branch counts, reserved names and the ±5pt reconciliation are enforced", () => {
  const badProb = { ...fomc, branches: fomc.branches.map((b, i) => (i === 0 ? { ...b, probability: 50 } : b)) };
  assert.match(validateSubmitted([badProb], split, "2026-12-01").join(" "), /probabilities must sum to 100/);
  const badSplit = { ...fomc, branches: fomc.branches.map((b, i) => (i === 0 ? { ...b, crash: 20 } : b)) };
  assert.match(validateSubmitted([badSplit], split, "2026-12-01").join(" "), /must sum to 100, got 112/);
  const oneBranch = { ...fomc, branches: [fomc.branches[0]] };
  assert.match(validateSubmitted([oneBranch], split, "2026-12-01").join(" "), /needs 2-5 branches/);
  const reserved = { ...fomc, branches: fomc.branches.map((b, i) => (i === 2 ? { ...b, outcome: "Other" } : b)) };
  assert.match(validateSubmitted([reserved], split, "2026-12-01").join(" "), /reserved/);
  // Copying last report's branches after the step-7 split moved fails reconciliation.
  const moved = { bull: 10, base: 40, bear: 30, crash: 20 };
  assert.match(validateSubmitted([fomc], moved, "2026-12-01").join(" "), /within ±5pts/);
  const four = [1, 2, 3, 4].map((i) => ({ ...fomc, event: `E${i}` }));
  assert.match(validateSubmitted(four, split, "2026-12-01").join(" "), /At most 3 events/);
});

test("not due on the event date itself; due the day after", () => {
  assert.equal(dueEvents([open(fomc)], "2026-12-09").length, 0);
  assert.equal(dueEvents([open(fomc)], "2026-12-10").length, 1);
});

test("a due event with no outcome rejects the write, naming the valid outcomes", () => {
  const r = resolveConditional([open(fomc)], [], [], split, "2026-12-10");
  assert.match(r.errors.join(" "), /is due: give its outcome \(one of: "hold", "hike 25bp", "cut 25bp", "other"\), or "unresolved"/);
});

test("scoring: the actual step-7 split vs the predicted branch, computed server-side", () => {
  const actual = { bull: 14, base: 40, bear: 32, crash: 14 };
  const r = resolveConditional([open(fomc)], [], [{ event: "dec 2026  fomc", event_date: "2026-12-09", outcome: "Hike 25bp" }], actual, "2026-12-10");
  assert.deepEqual(r.errors, []);
  assert.equal(r.open.length, 0); // scored, no longer open
  const s = r.scoring[0];
  assert.equal(s.outcome, "hike 25bp");
  assert.equal(s.outcome_probability, 30);
  assert.deepEqual(s.predicted_split, { bull: 16, base: 42, bear: 29, crash: 13 });
  assert.deepEqual(s.change, { bull: -2, base: -2, bear: 3, crash: 1 });
  assert.equal(s.prediction_made_on, "2026-12-08");
});

test('"other" scores with probability 0 and no split comparison; unknown names are rejected', () => {
  const ok = resolveConditional([open(fomc)], [], [{ event: "Dec 2026 FOMC", event_date: "2026-12-09", outcome: "other", reason: "50bp cut" }], split, "2026-12-10");
  assert.equal(ok.scoring[0].outcome_probability, 0);
  assert.equal(ok.scoring[0].change, null);
  const bad = resolveConditional([open(fomc)], [], [{ event: "Dec 2026 FOMC", event_date: "2026-12-09", outcome: "cut 50bp" }], split, "2026-12-10");
  assert.match(bad.errors.join(" "), /matches no branch/);
});

test('"unresolved" needs a reason, keeps the event open and due, and lets the write succeed', () => {
  const noReason = resolveConditional([open(fomc)], [], [{ event: "Dec 2026 FOMC", event_date: "2026-12-09", outcome: "unresolved" }], split, "2026-12-10");
  assert.match(noReason.errors.join(" "), /needs a reason/);
  const r = resolveConditional([open(fomc)], [], [{ event: "Dec 2026 FOMC", event_date: "2026-12-09", outcome: "unresolved", reason: "statement delayed" }], split, "2026-12-10");
  assert.deepEqual(r.errors, []);
  assert.equal(r.scoring.length, 0);
  assert.equal(r.open.length, 1);
  assert.deepEqual(r.open[0].last_unresolved, { on: "2026-12-10", reason: "statement delayed" });
  assert.equal(dueEvents(r.open, "2026-12-11").length, 1); // still due next run
});

test("carry-forward: untouched open predictions persist; re-submitting the same event replaces it", () => {
  const carried = resolveConditional([open(fomc, "2026-12-01")], [], [], split, "2026-12-03");
  assert.equal(carried.open.length, 1);
  assert.equal(carried.open[0].made_on, "2026-12-01");
  const replaced = resolveConditional([open(fomc, "2026-12-01")], [{ ...fomc, event: " DEC 2026 fomc " }], [], split, "2026-12-08");
  assert.equal(replaced.open.length, 1);
  assert.equal(replaced.open[0].made_on, "2026-12-08"); // latest prediction before the event wins
});

test("an outcome for an event that isn't due is rejected", () => {
  const r = resolveConditional([open(fomc)], [], [{ event: "Dec 2026 FOMC", event_date: "2026-12-09", outcome: "hold" }], split, "2026-12-09");
  assert.match(r.errors.join(" "), /isn't a due open prediction/);
});
