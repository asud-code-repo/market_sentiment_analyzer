import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { load } from "js-yaml";
import { validateRegistry, unverifiedPrimaries, reviewStatus, slotReadiness, type Registry, type ReviewStatus, type ReadinessGrade } from "./instruments.js";
import { RULE_SLOTS } from "./waveDeployment.js";
import { readExchangeLog } from "./exchangeLog.js";
import { exchangeContext, type ExchangeEntry } from "./tradeRestrictions.js";
import { readFilingCache, unreviewed } from "./fundFilings.js";
import type { ResolveContext, FilingEventRef } from "./instruments.js";

/**
 * Reads local_state/deployment_instruments.yaml — the slot -> instrument
 * registry. Same trust boundary as portfolio.ts: local-only, gitignored,
 * never sent to Supabase. Path is DEPLOYMENT_INSTRUMENTS_PATH if set,
 * otherwise deployment_instruments.yaml next to PORTFOLIO_PATH (so existing
 * Claude Desktop configs work without a new env entry).
 */
function registryPath(): string {
  const explicit = process.env.DEPLOYMENT_INSTRUMENTS_PATH;
  if (explicit) return explicit;
  const portfolio = process.env.PORTFOLIO_PATH;
  if (!portfolio) {
    throw new Error("Neither DEPLOYMENT_INSTRUMENTS_PATH nor PORTFOLIO_PATH is set — see mcp_server/.env.example");
  }
  return join(dirname(portfolio), "deployment_instruments.yaml");
}

export type RegistryLoad =
  | {
      ok: true;
      registry: Registry;
      health: RegistryHealth;
      exchangeLog: ExchangeEntry[];
      filingEvents: FilingEventRef[];
      exchangeCtx: ResolveContext;
    }
  | { ok: false; health: RegistryHealth };

export interface RegistryHealth {
  valid: boolean;
  errors: string[];
  review: { last_full_review: string | null; next_review_due: string | null; status: ReviewStatus };
  unverified_primaries: string[];
  // Slot ids by readiness grade (see gradeReadiness). Reasons for AMBER/RED
  // come from run_deployment_fire_drill, kept out of here to stay compact.
  readiness: Record<ReadinessGrade, string[]> | null;
  // Set when exchange_log.yaml can't be read; readiness then ignores
  // trading restrictions (and says so here).
  exchange_log_error?: string;
  unreviewed_filing_events?: number;
  filing_cache_error?: string;
}

const UNKNOWN_REVIEW = { last_full_review: null, next_review_due: null, status: "UNKNOWN" as const };

/**
 * Loads and validates the registry. Never throws: a missing or invalid
 * registry must not hide the dollar plan (rules + waveDeployment.ts are the
 * source of truth for amounts), so failures come back as health.errors.
 */
export function loadInstrumentRegistry(today: Date): RegistryLoad {
  let raw: unknown;
  try {
    raw = load(readFileSync(registryPath(), "utf-8"));
  } catch (err) {
    return {
      ok: false,
      health: {
        valid: false,
        errors: [`Could not read deployment instrument registry: ${(err as Error).message}`],
        review: UNKNOWN_REVIEW,
        unverified_primaries: [],
        readiness: null,
      },
    };
  }
  const errors = validateRegistry(raw, RULE_SLOTS);
  const reg = raw as Registry;
  const lastReview = (raw as { last_full_review?: unknown } | null)?.last_full_review;
  const valid = errors.length === 0;
  const lastReviewIso =
    lastReview instanceof Date ? lastReview.toISOString().slice(0, 10) : typeof lastReview === "string" ? lastReview : null;
  let exchangeLog: ExchangeEntry[] = [];
  let exchangeLogError: string | undefined;
  try {
    exchangeLog = readExchangeLog();
  } catch (err) {
    exchangeLogError = `${(err as Error).message} — trading-restriction checks are ignoring the log`;
  }
  let filingEvents: FilingEventRef[] = [];
  let filingCacheError: string | undefined;
  try {
    filingEvents = unreviewed(readFilingCache());
  } catch (err) {
    filingCacheError = `fund_filing_events.yaml unreadable: ${(err as Error).message}`;
  }
  const exchangeCtx: ResolveContext = { ...exchangeContext(exchangeLog, today), filingEvents };
  let readiness: Record<ReadinessGrade, string[]> | null = null;
  if (valid) {
    const graded = slotReadiness(reg, today, exchangeCtx);
    readiness = { GREEN: graded.GREEN.map((x) => x.slot), AMBER: graded.AMBER.map((x) => x.slot), RED: graded.RED.map((x) => x.slot) };
  }
  const health: RegistryHealth = {
    valid,
    errors,
    review: valid ? reviewStatus(lastReviewIso, reg.verification_max_age_days, today) : { ...UNKNOWN_REVIEW, last_full_review: lastReviewIso },
    unverified_primaries: valid ? unverifiedPrimaries(reg, today) : [],
    readiness,
    ...(exchangeLogError ? { exchange_log_error: exchangeLogError } : {}),
    ...(filingEvents.length ? { unreviewed_filing_events: filingEvents.length } : {}),
    ...(filingCacheError ? { filing_cache_error: filingCacheError } : {}),
  };
  return valid ? { ok: true, registry: reg, health, exchangeLog, filingEvents, exchangeCtx } : { ok: false, health };
}

/**
 * One-line-ish summary for get_portfolio_snapshot, which the daily crash
 * check calls every run (get_deployment_plan is only called when a wave is
 * active) — so the quarterly-review reminder and RED slots surface in calm
 * markets, which is when they're supposed to be fixed.
 */
export function compactReadiness(health: RegistryHealth): Record<string, unknown> {
  if (!health.valid) {
    return { registry_valid: false, errors: health.errors, action: "Fix local_state/deployment_instruments.yaml" };
  }
  const r = health.readiness!;
  return {
    registry_valid: true,
    review_status: health.review.status,
    next_review_due: health.review.next_review_due,
    slots: { GREEN: r.GREEN.length, AMBER: r.AMBER.length, RED: r.RED.length },
    red_slots: r.RED,
    ...(health.exchange_log_error ? { exchange_log_error: health.exchange_log_error } : {}),
    ...(health.unreviewed_filing_events ? { unreviewed_filing_events: health.unreviewed_filing_events } : {}),
    detail: "run_deployment_fire_drill for reasons and a simulated trade list",
  };
}
