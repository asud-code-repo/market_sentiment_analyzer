// Run: npm test. Made-up fixture funds and the public example policy only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { ruleSlots, loadPolicy } from "./waveDeployment.js";
import { runFireDrill } from "./fireDrill.js";
import { buildFireDrillSnapshot, CRASH_TYPES } from "./fireDrillSnapshot.js";
import type { Registry } from "./instruments.js";
import type { RegistryHealth } from "./deploymentInstruments.js";

const EXAMPLE_POLICY = fileURLToPath(new URL("../../../local_state/policy.example.yaml", import.meta.url));
process.env.POLICY_PATH = EXAMPLE_POLICY;

const TODAY = new Date("2026-06-15T12:00:00Z");
const DRY_POWDER = 123_457; // distinctive, so any leaked dollar amount is easy to spot

function registry(): Registry {
  const ok = { name: "Example Fund", route: "in_plan" as const, verified_on: "2026-06-01" };
  const blocked = { name: "Example ETF", ticker: "XMPL", route: "brokerage_window" as const, verified_on: "2026-06-01" };
  const reg: Registry = {
    schema_version: 1,
    verification_max_age_days: 90,
    routes: { in_plan: { status: "ok" }, brokerage_window: { status: "blocked", constraint: "Example wait" } },
    slots: {},
  };
  for (const id of ruleSlots()) {
    reg.slots[id] = { used_by: [], role: "Example", primary: id === "tips" ? blocked : ok, backup: ok };
  }
  return reg;
}

const HEALTH: RegistryHealth = {
  valid: true,
  errors: [],
  review: { last_full_review: "2026-05-01", next_review_due: "2026-08-01", status: "OK" as RegistryHealth["review"]["status"] },
  unverified_primaries: [],
  readiness: null,
  unreviewed_filing_events: 2,
};

test("fire drill snapshot: six scenarios, percentages only, no dollar amounts", () => {
  const snap = buildFireDrillSnapshot(DRY_POWDER, registry(), HEALTH, TODAY);
  assert.deepEqual(snap.scenarios.map((s) => s.crash_type), [null, ...CRASH_TYPES]);
  for (const s of snap.scenarios) {
    assert.ok(Math.abs(s.pct_executable_via_primary + s.pct_executable_via_backup_only + s.pct_blocked - 100) < 0.2);
  }
  // No usd field anywhere, and none of the drill's dollar amounts in the text.
  const json = JSON.stringify(snap);
  assert.ok(!json.includes("usd"));
  const amounts = [null, ...CRASH_TYPES].flatMap((ct) => runFireDrill("WAVE_3", ct, DRY_POWDER, registry(), TODAY).lines.map((l) => l.usd));
  for (const a of amounts.filter((a) => a >= 100)) {
    assert.ok(!json.includes(String(Math.round(a))), `dollar amount ${a} leaked`);
  }
  assert.ok(!json.includes(String(DRY_POWDER)));
  assert.equal(snap.unreviewed_filing_events, 2);
  assert.equal(snap.registry_review.status, "OK");
});

test("fire drill snapshot: only AMBER/RED lines, wave lines once, policy percentages", () => {
  const snap = buildFireDrillSnapshot(DRY_POWDER, registry(), HEALTH, TODAY);
  assert.ok(snap.attention_lines.length > 0);
  assert.ok(snap.attention_lines.every((l) => l.grade !== "GREEN" && l.slot === "tips"));
  const keys = snap.attention_lines.map((l) => `${l.source}:${l.slot}`);
  assert.equal(new Set(keys).size, keys.length);
  // A Wave 2 TIPS line carries the policy's own share of dry powder.
  const p = loadPolicy(EXAMPLE_POLICY);
  const w2 = snap.attention_lines.find((l) => l.source === "WAVE_2");
  if (w2) {
    const expected = (p.waves.WAVE_2.pct_of_dry_powder * p.waves.WAVE_2.splits.find((s) => s.slot === "tips")!.pct_of_wave) / 100;
    assert.ok(Math.abs(w2.pct_of_dry_powder - expected) < 0.1);
  }
  assert.ok(snap.green_line_count > 0);
});
