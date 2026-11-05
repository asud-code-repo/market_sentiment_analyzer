// Deployment-instrument registry, phase 1 (crash-check-rules.md
// "Deployment Instrument Selection"). Pure functions, no I/O — the caller
// loads local_state/deployment_instruments.yaml (gitignored; real plan menu)
// and passes the parsed object in. See deploymentInstruments.ts for the loader.
//
// The registry answers only "which instrument fills this slot". It never
// changes pct, amount, wave authorization, or cumulative deployment — those
// stay in waveDeployment.ts / crash-check-rules.md. It never picks or swaps
// an instrument on its own either: a swap is a human edit to the YAML.

import {
  restrictionStatus,
  instrumentNames,
  validateTradeRestriction,
  type TradeRestriction,
  type ExchangeContext,
  type RestrictionStatus,
} from "./tradeRestrictions.js";

export type Route = "in_plan" | "brokeragelink" | "none";
export type RouteStatus = "ok" | "pending" | "blocked";
// Fund-level availability to new money. "limited" = soft-closed / unclear
// whether the plan can still add; "closed" = can't buy at all.
export type Availability = "open" | "limited" | "closed";

export interface Instrument {
  name: string;
  ticker?: string | null;
  // Public share class of the same portfolio, for funds held via a plan-only
  // class with no market price — used by the EDGAR watch and role-fit metrics.
  proxy_ticker?: string | null;
  plan_name?: string;
  route: Route;
  vehicle?: string;
  availability?: Availability;
  expense_ratio_pct?: number | null;
  flags?: string[];
  notes?: string;
  // YYYY-MM-DD. Quoted in YAML it's a string; an unquoted date is parsed by
  // js-yaml into a Date, so accept both rather than silently misreading it.
  verified_on?: string | Date | null;
  sources?: string[];
  trade_restrictions?: TradeRestriction;
}

export type InstrumentOrRef = Instrument | { ref: string };

/**
 * Report-only role-fit spec (see roleFit.ts). benchmark is a ticker or a
 * {ticker: weight} blend; compare_to adds a second correlation (e.g. QQQ for a
 * real-estate fund drifting toward tech); breakeven_series regresses returns
 * on a FRED breakeven series in data_points. proposed_bands are NOT adopted —
 * shown for the quarterly review only, never graded.
 */
export interface RoleFitSpec {
  benchmark?: string | Record<string, number>;
  compare_to?: string;
  breakeven_series?: string;
  proposed_bands?: Record<string, string>;
  manual_only?: string;
}

export interface Slot {
  used_by: string[];
  role: string;
  primary: InstrumentOrRef;
  backup: InstrumentOrRef;
  open_decision?: string;
  role_fit?: RoleFitSpec;
}

/** Unreviewed fund-filing event from the EDGAR watch (fundFilings.ts cache). */
export interface FilingEventRef {
  instrument_ids: string[]; // ticker/proxy/plan name the event was found for
  kind: "structural" | "fee_or_manager";
  filed: string;
  phrases: string[];
  url: string;
}

export type ResolveContext = ExchangeContext & { filingEvents?: FilingEventRef[] };

export interface RouteDef {
  description?: string;
  status: RouteStatus;
  constraint?: string;
  open_questions?: string[];
  notes?: string[];
}

export interface Registry {
  schema_version: number;
  verification_max_age_days: number;
  last_full_review?: string;
  routes: Record<string, RouteDef>;
  slots: Record<string, Slot>;
  unassigned_watchlist?: string[];
}

export type VerificationStatus = "VERIFIED" | "UNVERIFIED";

export interface ResolvedInstrument extends Instrument {
  verified_on: string | null;
  verification: { status: VerificationStatus; age_days: number | null };
  route_status: RouteStatus | "n/a";
  route_constraint: string | null;
  route_open_questions: string[];
  restriction: RestrictionStatus | null;
  filing_events: FilingEventRef[];
}

export type ReadinessGrade = "GREEN" | "AMBER" | "RED";

/**
 * "If a wave fired today, could this line's money actually get there?"
 * GREEN = primary executable and verified. AMBER = executable, but only via
 * the backup, or the primary is unverified / limited. RED = neither
 * instrument can be bought today. Deliberately ignores returns — readiness
 * is about executability, never about whether the fund has done well.
 */
export interface Readiness {
  grade: ReadinessGrade;
  executable_via: "primary" | "backup" | null;
  reasons: string[];
}

export interface InstrumentResolution {
  role: string | null;
  primary: ResolvedInstrument | null;
  backup: ResolvedInstrument | null;
  readiness: Readiness | null; // null for hold/remainder lines
  warnings: string[];
}

const DAY_MS = 86_400_000;
const KNOWN_ROUTES: Route[] = ["in_plan", "brokeragelink", "none"];

function isoDate(v: string | Date | null | undefined): string | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  return typeof v === "string" && v.length > 0 ? v : null;
}

function ageDays(verifiedOn: string | null, today: Date): number | null {
  if (!verifiedOn) return null;
  const t = Date.parse(verifiedOn + "T00:00:00Z");
  if (Number.isNaN(t)) return null;
  return Math.floor((today.getTime() - t) / DAY_MS);
}

function isRef(entry: InstrumentOrRef): entry is { ref: string } {
  return typeof (entry as { ref?: unknown }).ref === "string";
}

export function deref(entry: InstrumentOrRef, reg: Registry, seen = new Set<string>()): Instrument {
  if (!isRef(entry)) return entry;
  if (seen.has(entry.ref)) throw new Error(`Circular ref: ${entry.ref}`);
  seen.add(entry.ref);
  const [slotId, which] = entry.ref.split(".");
  const slot = reg.slots[slotId];
  if (!slot || (which !== "primary" && which !== "backup")) {
    throw new Error(`Bad ref: ${entry.ref}`);
  }
  return deref(slot[which], reg, seen);
}

const NO_EXCHANGES = (today: Date): ResolveContext => ({
  quarterEntries: [],
  ownDay: today.toISOString().slice(0, 10),
  allPlanExchangesCount: false,
});

export function instrumentIds(inst: Instrument): string[] {
  return [inst.ticker, inst.proxy_ticker, inst.plan_name].filter((x): x is string => !!x).map((x) => x.toUpperCase());
}

function resolveOne(entry: InstrumentOrRef, reg: Registry, today: Date, ctx: ResolveContext): ResolvedInstrument {
  const inst = deref(entry, reg);
  const verifiedOn = isoDate(inst.verified_on);
  const age = ageDays(verifiedOn, today);
  const status: VerificationStatus =
    age !== null && age >= 0 && age <= reg.verification_max_age_days ? "VERIFIED" : "UNVERIFIED";
  const route = inst.route === "none" ? undefined : reg.routes[inst.route];
  return {
    ...inst,
    verified_on: verifiedOn,
    verification: { status, age_days: age },
    // A route the registry doesn't define is treated as pending, never ok.
    route_status: inst.route === "none" ? "n/a" : (route?.status ?? "pending"),
    route_constraint: route?.constraint ?? null,
    route_open_questions: route?.open_questions ?? [],
    restriction: inst.trade_restrictions
      ? restrictionStatus(inst.trade_restrictions, instrumentNames(inst), ctx, today)
      : null,
    filing_events: (ctx.filingEvents ?? []).filter((e) =>
      e.instrument_ids.some((id) => instrumentIds(inst).includes(id.toUpperCase())),
    ),
  };
}

function label(inst: ResolvedInstrument): string {
  return inst.ticker ?? inst.plan_name ?? inst.name;
}

/** Why an instrument can't be bought today, or null if it can. */
function blocker(inst: ResolvedInstrument): string | null {
  if (inst.route === "none") return "no instrument (hold in stable value)";
  if (inst.availability === "closed") return "closed to new money";
  if (inst.restriction?.exhausted) {
    return `exchange-day limit used this quarter (${inst.restriction.quarter}: ${inst.restriction.days_used.join(", ")})`;
  }
  if (inst.route_status === "blocked") return `route ${inst.route} blocked`;
  if (inst.route_status === "pending") return `route ${inst.route} pending`;
  return null;
}

// Only structural events (merger / reorganization / liquidation / closure)
// downgrade readiness; fee events are a review flag only. Either way the
// instrument stays buyable — closure is set by hand via availability.
function filingReasons(which: string, inst: ResolvedInstrument): string[] {
  return inst.filing_events
    .filter((e) => e.kind === "structural")
    .map((e) => `${which} ${label(inst)}: unreviewed fund filing ${e.filed} (${e.phrases.join(", ")}) — review`);
}

export function gradeReadiness(primary: ResolvedInstrument, backup: ResolvedInstrument): Readiness {
  const pBlock = blocker(primary);
  if (pBlock === null) {
    const reasons: string[] = filingReasons("primary", primary);
    if (primary.verification.status === "UNVERIFIED") reasons.push(`primary ${label(primary)} unverified`);
    if (primary.availability === "limited") reasons.push(`primary ${label(primary)} limited to new money`);
    return { grade: reasons.length ? "AMBER" : "GREEN", executable_via: "primary", reasons };
  }
  const reasons = [`primary ${label(primary)}: ${pBlock}`];
  const bBlock = blocker(backup);
  if (bBlock === null) {
    reasons.push(...filingReasons("backup", backup));
    if (backup.verification.status === "UNVERIFIED") reasons.push(`backup ${label(backup)} unverified`);
    if (backup.availability === "limited") reasons.push(`backup ${label(backup)} limited to new money`);
    return { grade: "AMBER", executable_via: "backup", reasons };
  }
  reasons.push(`backup ${label(backup)}: ${bBlock}`);
  return { grade: "RED", executable_via: null, reasons };
}

function routeWarning(which: "Primary" | "Backup", inst: ResolvedInstrument): string | null {
  if (inst.route_status === "blocked") {
    return `${which} ${label(inst)}: route ${inst.route} is BLOCKED — ${inst.route_constraint ?? "no constraint recorded"}`;
  }
  if (inst.route_status === "pending") {
    const qs = inst.route_open_questions.length ? `: ${inst.route_open_questions.join("; ")}` : "";
    return `${which} ${label(inst)}: route ${inst.route} is pending${qs}`;
  }
  return null;
}

/**
 * Resolves one slot to its primary/backup instruments plus warnings. A null
 * slot (a "hold"/"remainder" line with no deployable amount) resolves to
 * nulls with no warnings.
 */
export function resolveSlot(
  slotId: string | null,
  reg: Registry,
  today: Date,
  ctx: ResolveContext = NO_EXCHANGES(today),
): InstrumentResolution {
  if (slotId === null) return { role: null, primary: null, backup: null, readiness: null, warnings: [] };
  const slot = reg.slots[slotId];
  if (!slot) {
    return {
      role: null,
      primary: null,
      backup: null,
      readiness: { grade: "RED", executable_via: null, reasons: [`slot "${slotId}" missing from registry`] },
      warnings: [`Slot "${slotId}" is missing from the instrument registry — add it before this wave fires`],
    };
  }
  const primary = resolveOne(slot.primary, reg, today, ctx);
  const backup = resolveOne(slot.backup, reg, today, ctx);
  const warnings: string[] = [];
  if (primary.verification.status === "UNVERIFIED") {
    warnings.push(`Primary ${label(primary)} is UNVERIFIED — re-check before trading`);
  }
  const pw = routeWarning("Primary", primary);
  if (pw) warnings.push(pw);
  // Same route, same status as the primary -> say it once, not twice.
  if (backup.route === primary.route && backup.route_status === primary.route_status) {
    if (pw) warnings[warnings.length - 1] = pw.replace(/^Primary /, "Primary and backup ").replace(`${label(primary)}:`, `${label(primary)}/${label(backup)}:`);
  } else {
    const bw = routeWarning("Backup", backup);
    if (bw) warnings.push(bw);
  }
  for (const inst of [primary, backup]) {
    if (inst.availability === "closed" || inst.availability === "limited") {
      warnings.push(`${inst === primary ? "Primary" : "Backup"} ${label(inst)} is ${inst.availability} to new money`);
    }
  }
  for (const inst of [primary, backup]) {
    const rs = inst.restriction;
    if (rs?.in_force && !rs.exhausted) {
      warnings.push(
        `${inst === primary ? "Primary" : "Backup"} ${label(inst)} has a trading restriction (${rs.policy}) — ` +
          `${rs.days_used.length}/${rs.days_allowed ?? "?"} exchange days used in ${rs.quarter}; trading it uses one`,
      );
    }
  }
  if (primary.restriction?.exhausted && backup.restriction == null) {
    warnings.push(`Backup ${label(backup)} has no recorded restriction, but covered funds are not confirmed — it may be covered too`);
  }
  if (slot.open_decision) warnings.push(`Open decision on this slot: ${slot.open_decision.trim()}`);
  return { role: slot.role, primary, backup, readiness: gradeReadiness(primary, backup), warnings };
}

/**
 * Attaches instruments to each plan line, leaving every existing field
 * (pct, usd, note) untouched.
 */
export function resolveInstruments<L extends { slot: string | null }>(
  lines: L[],
  reg: Registry,
  today: Date,
  ctx: ResolveContext = NO_EXCHANGES(today),
): (L & { instruments: InstrumentResolution })[] {
  return lines.map((line) => ({ ...line, instruments: resolveSlot(line.slot, reg, today, ctx) }));
}

/**
 * Structural check, run every time the registry is loaded (including when no
 * wave is active) so a bad registry fails loudly in a calm market, not
 * mid-crash. Returns a list of errors; empty = valid.
 */
export function validateRegistry(raw: unknown, requiredSlots: readonly string[]): string[] {
  const errors: string[] = [];
  const reg = raw as Partial<Registry> | null;
  if (!reg || typeof reg !== "object") return ["Registry is empty or not a mapping"];
  if (reg.schema_version !== 1) errors.push(`Unsupported schema_version: ${String(reg.schema_version)}`);
  if (typeof reg.verification_max_age_days !== "number" || reg.verification_max_age_days <= 0) {
    errors.push("verification_max_age_days must be a positive number");
  }
  if (!reg.routes || typeof reg.routes !== "object") errors.push("Missing routes");
  if (!reg.slots || typeof reg.slots !== "object") {
    errors.push("Missing slots");
    return errors;
  }
  const routes = reg.routes ?? {};
  for (const [id, r] of Object.entries(routes)) {
    if (!["ok", "pending", "blocked"].includes(r?.status)) errors.push(`routes.${id}: unknown status "${r?.status}"`);
    if (r?.status === "blocked" && !r.constraint) errors.push(`routes.${id}: blocked route needs a constraint`);
  }
  for (const id of requiredSlots) {
    if (!reg.slots[id]) errors.push(`Missing slot used by rules: ${id}`);
  }
  for (const [id, slot] of Object.entries(reg.slots)) {
    if (!slot?.role) errors.push(`${id}: missing role`);
    for (const which of ["primary", "backup"] as const) {
      if (!slot?.[which]) {
        errors.push(`${id}.${which}: missing`);
        continue;
      }
      try {
        const inst = deref(slot[which], reg as Registry);
        if (!inst.name) errors.push(`${id}.${which}: missing name`);
        if (!KNOWN_ROUTES.includes(inst.route)) {
          errors.push(`${id}.${which}: unknown route "${inst.route}"`);
        } else if (inst.route !== "none" && !routes[inst.route]) {
          errors.push(`${id}.${which}: route "${inst.route}" not defined under routes`);
        }
        if (inst.availability !== undefined && !["open", "limited", "closed"].includes(inst.availability)) {
          errors.push(`${id}.${which}: unknown availability "${inst.availability}"`);
        }
        if (inst.proxy_ticker != null && typeof inst.proxy_ticker !== "string") {
          errors.push(`${id}.${which}: proxy_ticker must be a string`);
        }
        if (inst.trade_restrictions !== undefined) {
          errors.push(...validateTradeRestriction(inst.trade_restrictions, `${id}.${which}`));
        }
        const v = inst.verified_on;
        if (v != null && isoDate(v) === null) errors.push(`${id}.${which}: unparseable verified_on`);
        if (typeof v === "string" && Number.isNaN(Date.parse(v + "T00:00:00Z"))) {
          errors.push(`${id}.${which}: verified_on "${v}" is not YYYY-MM-DD`);
        }
      } catch (e) {
        errors.push(`${id}.${which}: ${(e as Error).message}`);
      }
    }
  }
  return errors;
}

export type ReviewStatus = "OK" | "DUE_SOON" | "OVERDUE" | "UNKNOWN";
const DUE_SOON_DAYS = 14;

/**
 * Quarterly-review reminder: due verification_max_age_days after
 * last_full_review (the same day full-review entries start going
 * UNVERIFIED). DUE_SOON in the final 14 days.
 */
export function reviewStatus(
  lastFullReview: string | null,
  maxAgeDays: number,
  today: Date,
): { last_full_review: string | null; next_review_due: string | null; status: ReviewStatus } {
  const t = lastFullReview ? Date.parse(lastFullReview + "T00:00:00Z") : NaN;
  if (Number.isNaN(t)) return { last_full_review: lastFullReview, next_review_due: null, status: "UNKNOWN" };
  const due = t + maxAgeDays * DAY_MS;
  const daysLeft = Math.floor((due - today.getTime()) / DAY_MS);
  return {
    last_full_review: lastFullReview,
    next_review_due: new Date(due).toISOString().slice(0, 10),
    status: daysLeft < 0 ? "OVERDUE" : daysLeft <= DUE_SOON_DAYS ? "DUE_SOON" : "OK",
  };
}

/** Readiness grade for every slot in the registry, grouped by grade. */
export function slotReadiness(
  reg: Registry,
  today: Date,
  ctx: ResolveContext = NO_EXCHANGES(today),
): Record<ReadinessGrade, { slot: string; reasons: string[] }[]> {
  const out: Record<ReadinessGrade, { slot: string; reasons: string[] }[]> = { GREEN: [], AMBER: [], RED: [] };
  for (const id of Object.keys(reg.slots)) {
    const r = resolveSlot(id, reg, today, ctx).readiness!;
    out[r.grade].push({ slot: id, reasons: r.reasons });
  }
  return out;
}

/** Slot ids whose primary is UNVERIFIED today — for the quarterly-review reminder. */
export function unverifiedPrimaries(reg: Registry, today: Date): string[] {
  return Object.keys(reg.slots).filter((id) => {
    try {
      return resolveOne(reg.slots[id].primary, reg, today, NO_EXCHANGES(today)).verification.status === "UNVERIFIED";
    } catch {
      return true;
    }
  });
}
