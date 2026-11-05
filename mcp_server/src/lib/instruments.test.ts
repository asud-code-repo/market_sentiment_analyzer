// Run: npm test (node's built-in test runner via tsx — no test framework
// dependency). Fixture uses made-up fund names; never real plan data.
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateRegistry, resolveInstruments, resolveSlot, reviewStatus, slotReadiness, type Registry } from "./instruments.js";
import { runFireDrill } from "./fireDrill.js";
import { RULE_SLOTS, computeWaveDeployment } from "./waveDeployment.js";

const TODAY = new Date("2026-06-15T12:00:00Z");

function fixture(): Registry {
  return {
    schema_version: 1,
    verification_max_age_days: 90,
    routes: {
      in_plan: { status: "ok" },
      brokeragelink: { status: "blocked", constraint: "Example rule: 90-day wait in a non-competing fund" },
    },
    slots: {
      sector_fund: {
        used_by: ["wave_1"],
        role: "Example sector exposure",
        primary: { name: "Example Sector Fund", route: "in_plan", verified_on: "2026-06-01" },
        backup: { name: "Example Broad Fund", route: "in_plan", verified_on: "2026-01-02" }, // >90 days
      },
      sector_etf: {
        used_by: ["wave_2"],
        role: "Example sector ETF",
        primary: { name: "Example Sector ETF", ticker: "XMPL", route: "brokeragelink", verified_on: "2026-06-01" },
        backup: { name: "Example Alt ETF", ticker: "XALT", route: "brokeragelink", verified_on: "2026-06-01" },
      },
      single_name: {
        used_by: ["type_a"],
        role: "Example single name",
        primary: { name: "Example Corp", ticker: "EXCO", route: "brokeragelink", verified_on: "2026-01-02" },
        backup: { ref: "sector_etf.primary" },
      },
    },
  };
}

test("valid registry produces no errors", () => {
  assert.deepEqual(validateRegistry(fixture(), ["sector_fund", "sector_etf", "single_name"]), []);
});

test("missing required slot, bad ref, undefined route and blocked-without-constraint are reported", () => {
  const reg = fixture();
  reg.slots.single_name.backup = { ref: "nope.primary" };
  reg.slots.sector_fund.primary = { name: "X", route: "in_plan", verified_on: "June" };
  reg.routes.brokeragelink = { status: "blocked" };
  delete (reg.routes as Record<string, unknown>).in_plan;
  const errors = validateRegistry(reg, ["sector_fund", "missing_slot"]);
  assert.ok(errors.some((e) => e.includes("missing_slot")));
  assert.ok(errors.some((e) => e.includes("Bad ref: nope.primary")));
  assert.ok(errors.some((e) => e.includes('route "in_plan" not defined')));
  assert.ok(errors.some((e) => e.includes("blocked route needs a constraint")));
  assert.ok(errors.some((e) => e.includes("not YYYY-MM-DD")));
});

test("circular refs are caught, not stack-overflowed", () => {
  const reg = fixture();
  reg.slots.sector_etf.backup = { ref: "single_name.backup" };
  reg.slots.single_name.backup = { ref: "sector_etf.backup" };
  assert.ok(validateRegistry(reg, []).some((e) => e.includes("Circular ref")));
});

test("refs resolve to the referenced instrument", () => {
  const r = resolveSlot("single_name", fixture(), TODAY);
  assert.equal(r.backup?.ticker, "XMPL");
});

test("entries older than verification_max_age_days are UNVERIFIED", () => {
  const r = resolveSlot("sector_fund", fixture(), TODAY);
  assert.equal(r.primary?.verification.status, "VERIFIED");
  assert.equal(r.backup?.verification.status, "UNVERIFIED");
  const single = resolveSlot("single_name", fixture(), TODAY);
  assert.equal(single.primary?.verification.status, "UNVERIFIED");
  assert.ok(single.warnings.some((w) => w.includes("EXCO is UNVERIFIED")));
});

test("missing verified_on and YAML Date values are handled", () => {
  const reg = fixture();
  reg.slots.sector_fund.primary = { name: "A", route: "in_plan", verified_on: null };
  reg.slots.sector_fund.backup = { name: "B", route: "in_plan", verified_on: new Date("2026-06-10T00:00:00Z") };
  const r = resolveSlot("sector_fund", reg, TODAY);
  assert.equal(r.primary?.verification.status, "UNVERIFIED");
  assert.equal(r.backup?.verified_on, "2026-06-10");
  assert.equal(r.backup?.verification.status, "VERIFIED");
});

test("a blocked route surfaces its constraint as a warning", () => {
  const r = resolveSlot("sector_etf", fixture(), TODAY);
  assert.equal(r.primary?.route_status, "blocked");
  assert.ok(r.warnings.some((w) => w.includes("BLOCKED") && w.includes("90-day wait")));
});

test("resolveInstruments leaves amounts untouched and handles hold lines", () => {
  const lines = [
    { fund: "Example", slot: "sector_fund", usd: 1234.56 },
    { fund: "Remainder", slot: null, usd: null },
    { fund: "Unknown", slot: "not_in_registry", usd: 10 },
  ];
  const out = resolveInstruments(lines, fixture(), TODAY);
  assert.equal(out[0].usd, 1234.56);
  assert.equal(out[0].instruments.primary?.name, "Example Sector Fund");
  assert.equal(out[1].instruments.primary, null);
  assert.deepEqual(out[1].instruments.warnings, []);
  assert.ok(out[2].instruments.warnings[0].includes("missing from the instrument registry"));
});

test("every wave split carries a slot listed in RULE_SLOTS", () => {
  const plan = computeWaveDeployment("WAVE_1", 1000);
  assert.deepEqual(plan.splits.map((s) => s.slot), ["healthcare_equity", "real_asset_fund", "intl_equity"]);
  assert.equal(new Set(RULE_SLOTS).size, 12);
});

test("readiness: GREEN when primary executable + verified, AMBER via backup, RED when both blocked", () => {
  const reg = fixture();
  assert.equal(resolveSlot("sector_fund", reg, TODAY).readiness?.grade, "GREEN");
  // primary blocked (brokeragelink), backup is a blocked ref too -> RED
  const red = resolveSlot("sector_etf", reg, TODAY).readiness!;
  assert.equal(red.grade, "RED");
  assert.equal(red.executable_via, null);
  // primary in a blocked route, backup in_plan -> AMBER via backup
  reg.slots.sector_etf.backup = { name: "Example Plan Fund", route: "in_plan", verified_on: "2026-06-01" };
  const amber = resolveSlot("sector_etf", reg, TODAY).readiness!;
  assert.deepEqual([amber.grade, amber.executable_via], ["AMBER", "backup"]);
});

test("readiness: unverified, limited, closed and hold-only backups", () => {
  const reg = fixture();
  reg.slots.sector_fund.primary = { name: "Old Fund", route: "in_plan", verified_on: "2025-01-01" };
  assert.equal(resolveSlot("sector_fund", reg, TODAY).readiness?.grade, "AMBER");
  reg.slots.sector_fund.primary = { name: "Soft-closed Fund", route: "in_plan", availability: "limited", verified_on: "2026-06-01" };
  assert.equal(resolveSlot("sector_fund", reg, TODAY).readiness?.grade, "AMBER");
  reg.slots.sector_fund.primary = { name: "Closed Fund", route: "in_plan", availability: "closed", verified_on: "2026-06-01" };
  reg.slots.sector_fund.backup = { name: "Hold in stable value", route: "none" };
  const r = resolveSlot("sector_fund", reg, TODAY).readiness!;
  assert.equal(r.grade, "RED");
  assert.ok(r.reasons.some((x) => x.includes("closed to new money")));
  assert.ok(r.reasons.some((x) => x.includes("hold in stable value")));
  assert.equal(resolveSlot("nope", reg, TODAY).readiness?.grade, "RED");
});

test("slotReadiness groups every slot", () => {
  const g = slotReadiness(fixture(), TODAY);
  assert.equal(g.GREEN.length + g.AMBER.length + g.RED.length, 3);
});

test("reviewStatus: OK, DUE_SOON, OVERDUE, UNKNOWN", () => {
  assert.equal(reviewStatus("2026-06-01", 90, TODAY).status, "OK");
  assert.equal(reviewStatus("2026-06-01", 90, TODAY).next_review_due, "2026-08-30");
  assert.equal(reviewStatus("2026-03-25", 90, TODAY).status, "DUE_SOON"); // due 2026-06-23
  assert.equal(reviewStatus("2026-01-01", 90, TODAY).status, "OVERDUE");
  assert.equal(reviewStatus(null, 90, TODAY).status, "UNKNOWN");
});

test("fire drill: blocked lines counted, shares sum to 100, hold lines skipped", () => {
  const reg = fixture();
  // Map every real rule slot onto the three fixture slots' shapes.
  for (const id of RULE_SLOTS) {
    reg.slots[id] = id === "tips" || id === "gold_etf" ? reg.slots.sector_etf : reg.slots.sector_fund;
  }
  const d = runFireDrill("WAVE_3", "A_STAGFLATION", 100_000, reg, TODAY);
  assert.equal(d.simulation, true);
  assert.ok(d.lines.every((l) => l.slot !== null));
  const s = d.summary;
  assert.ok(Math.abs(s.pct_executable_via_primary + s.pct_executable_via_backup_only + s.pct_blocked - 100) < 0.2);
  assert.deepEqual(s.blocked_slots.sort(), ["gold_etf", "tips"]);
  // Wave 2 TIPS (12% of 21.7%) + Wave 3 gold (25% of 17.4%) + Type A TIPS 4.35%
  const blockedUsd = d.lines.filter((l) => l.would_buy === null).reduce((a, l) => a + l.usd, 0);
  assert.ok(Math.abs(blockedUsd - (2604 + 4350 + 4350)) < 1);
});

// --- Trading restrictions + exchange days -----------------------------------

import { exchangeContext, quarterOf, restrictionStatus, type ExchangeEntry } from "./tradeRestrictions.js";

function restrictedFixture(): Registry {
  const reg = fixture();
  reg.slots.glide = {
    used_by: ["wave_2", "wave_3"],
    role: "Example glide path",
    primary: {
      name: "Example Target Fund",
      plan_name: "EX TARGET Y",
      route: "in_plan",
      verified_on: "2026-06-01",
      trade_restrictions: { policy: "Example excessive trading", exchange_days_per_quarter: 1, covered_funds: "TBC" },
    },
    backup: { name: "Example Index Trust", plan_name: "EX INDEX TR", route: "in_plan", verified_on: "2026-06-01" },
  };
  return reg;
}

test("quarterOf uses calendar quarters", () => {
  assert.deepEqual(quarterOf(TODAY), { label: "2026-Q2", start: "2026-04-01", end: "2026-06-30" });
});

test("restricted primary with this quarter's day used -> AMBER via backup", () => {
  const reg = restrictedFixture();
  const log: ExchangeEntry[] = [{ date: "2026-05-10", bought: ["EX TARGET Y"], sold: ["Stable"] }];
  const r = resolveSlot("glide", reg, TODAY, exchangeContext(log, TODAY));
  assert.deepEqual([r.readiness?.grade, r.readiness?.executable_via], ["AMBER", "backup"]);
  assert.ok(r.readiness?.reasons[0].includes("exchange-day limit used"));
  assert.ok(r.warnings.some((w) => w.includes("may be covered too")));
});

test("restriction: last quarter, same day, unrelated fund (TBC) and worst case", () => {
  const reg = restrictedFixture();
  const grade = (log: ExchangeEntry[], all = false) =>
    resolveSlot("glide", reg, TODAY, exchangeContext(log, TODAY, all)).readiness?.grade;
  assert.equal(grade([{ date: "2026-03-30", bought: ["EX TARGET Y"], sold: [] }]), "GREEN"); // prior quarter
  assert.equal(grade([{ date: "2026-06-15", bought: ["EX TARGET Y"], sold: [] }]), "GREEN"); // today: same day ok
  const other = [{ date: "2026-05-10", bought: ["Other Fund"], sold: ["Stable"] }];
  assert.equal(grade(other), "GREEN"); // covered funds TBC: only this fund counts
  assert.equal(grade(other, true), "AMBER"); // worst case: every exchange counts
  assert.equal(grade([{ date: "2026-05-10", bought: ["UNKNOWN"], sold: [] }]), "AMBER"); // unrecorded funds count
});

test("restriction: explicit covered list, out-of-force window, unknown limit", () => {
  const tr = { policy: "p", exchange_days_per_quarter: 1, covered_funds: ["Other Fund"] };
  const log = exchangeContext([{ date: "2026-05-10", bought: ["Other Fund"], sold: [] }], TODAY);
  assert.equal(restrictionStatus(tr, ["EX TARGET Y"], log, TODAY).exhausted, true);
  assert.equal(restrictionStatus({ ...tr, end: "2026-05-31" }, ["EX TARGET Y"], log, TODAY).exhausted, false);
  assert.equal(restrictionStatus({ ...tr, exchange_days_per_quarter: null }, ["EX TARGET Y"], log, TODAY).exhausted, false);
});

test("validate trade_restrictions shape", () => {
  const reg = restrictedFixture();
  (reg.slots.glide.primary as { trade_restrictions: unknown }).trade_restrictions = { policy: "", exchange_days_per_quarter: "one", covered_funds: "all", start: "soon" };
  const errors = validateRegistry(reg, []);
  for (const frag of ["policy missing", "must be a number", "covered_funds", "start is not"]) {
    assert.ok(errors.some((e) => e.includes(frag)), frag);
  }
});

test("fire drill: Waves 2 and 3 in one quarter -> Wave 3's restricted buy reroutes to backup", () => {
  const reg = restrictedFixture();
  for (const id of RULE_SLOTS) reg.slots[id] = reg.slots.sector_fund;
  reg.slots.target_date = reg.slots.glide;
  const d = runFireDrill("WAVE_3", null, 100_000, reg, TODAY);
  const td = d.lines.filter((l) => l.slot === "target_date");
  assert.deepEqual(td.map((l) => [l.source, l.would_buy?.via]), [["WAVE_2", "primary"], ["WAVE_3", "backup"]]);
  assert.deepEqual(d.summary.rerouted_by_trading_limit, ["WAVE_3:target_date"]);
  assert.deepEqual(d.transactions.map((t) => t.restricted_instruments_bought.length), [0, 1, 0]);
  // Worst case: Wave 1's exchange already uses the day, so Wave 2 reroutes too.
  const worst = runFireDrill("WAVE_3", null, 100_000, reg, TODAY, [], true);
  assert.deepEqual(worst.summary.rerouted_by_trading_limit, ["WAVE_2:target_date", "WAVE_3:target_date"]);
});

// --- Fund-filing classifier + role-fit math ------------------------------------

import { classifyDocument, isSupplement, seriesInHeader } from "./fundFilings.js";
import { correlation, beta, annualizedVolPct, drawdownEpisodes, dailyReturns, blendReturns, computeRoleFit, type PriceSeries } from "./roleFit.js";

test("filing classifier: supplements vs routine documents", () => {
  const sticker = (body: string) => `Example Funds Supplement dated March 1, 2026 to the Prospectus. ${body}`;
  assert.deepEqual(classifyDocument(sticker("The Board approved an Agreement and Plan of Reorganization.")).kind, "structural");
  assert.deepEqual(classifyDocument(sticker("The Fund is closed to new investors effective May 1.")).phrases, ["closed to new investors"]);
  assert.equal(classifyDocument(sticker("Jane Doe will retire as portfolio manager.")).kind, "fee_or_manager");
  assert.equal(classifyDocument(sticker("Updated phone number.")).kind, "routine");
  // Annual SAI / summary prospectus boilerplate never counts, however many keywords it has.
  assert.equal(classifyDocument("Statement of Additional Information ... mergers ... plan of liquidation ...").kind, "routine");
  assert.equal(isSupplement("Summary Prospectus (as supplemented on June 30, 2026) Portfolio Managers ..."), false);
  assert.equal(isSupplement(sticker("x".repeat(70_000))), false); // too long to be a sticker
});

test("filing header: series ids parsed", () => {
  const h = "<SERIES>\n<OWNER-CIK>0000000001\n<SERIES-ID>S000123456\n<SERIES-NAME>Example Energy Fund\n<CLASS-CONTRACT>";
  assert.deepEqual(seriesInHeader(h), [{ id: "S000123456", name: "Example Energy Fund" }]);
});

function series(values: number[], start = Date.UTC(2025, 0, 1)): PriceSeries {
  return new Map(values.map((v, i) => [new Date(start + i * 86_400_000).toISOString().slice(0, 10), v]));
}

test("role-fit math: correlation, beta, vol on known inputs", () => {
  const x = Array.from({ length: 100 }, (_, i) => Math.sin(i) / 100);
  const y = x.map((v) => 2 * v);
  assert.ok(Math.abs(correlation(x, y)! - 1) < 1e-9);
  assert.ok(Math.abs(correlation(x, x.map((v) => -v))! + 1) < 1e-9);
  assert.ok(Math.abs(beta(y, x)! - 2) < 1e-9);
  assert.equal(correlation(x.slice(0, 10), y.slice(0, 10)), null); // too few points
  const flatVol = annualizedVolPct(Array(50).fill(0.001));
  assert.ok(flatVol !== null && flatVol < 1e-9);
});

test("role-fit math: drawdown episodes and blends", () => {
  const eps = drawdownEpisodes(series([100, 95, 85, 90, 101, 99, 70, 80]));
  assert.deepEqual(eps.map((e) => [e.depth_pct]), [[15], [30.7]]); // second still open at the end
  const r = dailyReturns(series([100, 110, 99]));
  assert.ok(Math.abs([...r.values()][0] - 0.1) < 1e-12);
  const b = blendReturns([{ r, w: 3 }, { r: new Map([...r].map(([d, v]) => [d, 0])), w: 1 }]);
  assert.ok(Math.abs([...b.values()][0] - 0.075) < 1e-12);
});

test("role-fit report: manual-only slot, missing price, proxy flagged, nothing graded", () => {
  const reg = fixture();
  reg.slots.sector_fund.role_fit = { benchmark: "BNCH", proposed_bands: { corr_benchmark: ">= 0.9" } };
  reg.slots.sector_fund.primary = { name: "Plan Fund", plan_name: "PLAN FUND", proxy_ticker: "PRXY", route: "in_plan" };
  reg.slots.sector_etf.role_fit = { manual_only: "no price" };
  const walk = Array.from({ length: 300 }, (_, i) => 100 + 10 * Math.sin(i / 7) + i / 10);
  const prices = new Map([["SPY", series(walk)], ["BNCH", series(walk)], ["PRXY", series(walk.map((v) => v * 2))]]);
  const out = computeRoleFit(reg, prices, new Map());
  const sf = out.find((s) => s.slot === "sector_fund")!;
  assert.equal(sf.instruments[0].proxy, true);
  assert.ok(Math.abs(sf.instruments[0].metrics!.corr_benchmark! - 1) < 0.01);
  assert.equal(sf.instruments[1].metrics, null); // backup has no price
  assert.equal(out.find((s) => s.slot === "sector_etf")!.manual_only, "no price");
  assert.ok(!JSON.stringify(out).match(/PASS|FAIL|breach/i));
});

test("unreviewed structural filing -> AMBER (still via primary); fee/manager -> no grade change", () => {
  const reg = fixture();
  reg.slots.sector_fund.primary = { name: "Example Fund", ticker: "EXFD", route: "in_plan", verified_on: "2026-06-01" };
  const ev = (kind: "structural" | "fee_or_manager") => ({
    ...exchangeContext([], TODAY),
    filingEvents: [{ instrument_ids: ["EXFD"], kind, filed: "2026-05-01", phrases: ["plan of reorganization"], url: "u" }],
  });
  const s = resolveSlot("sector_fund", reg, TODAY, ev("structural")).readiness!;
  assert.deepEqual([s.grade, s.executable_via], ["AMBER", "primary"]);
  assert.ok(s.reasons[0].includes("unreviewed fund filing"));
  assert.equal(resolveSlot("sector_fund", reg, TODAY, ev("fee_or_manager")).readiness?.grade, "GREEN");
});
