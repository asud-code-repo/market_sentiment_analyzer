// Event-conditional scenario splits + scoring (build spec E8, 2026-11-13;
// crash-check-rules.md "Event-conditional scenarios"). Pure logic only; the
// write path (write_snapshot) and read path (get_latest_snapshot) call this.
//
// Anti-anchoring contract (project-instructions.md):
//   - branches are FORMED in step 7, alongside the unconditional split,
//     before step 8 shows any prior prediction;
//   - they are WRITTEN only in step 11 (write_snapshot's input);
//   - they are RETURNED only in step 8 (get_latest_snapshot). No step 1-6
//     tool reads these columns.
// The ±5pt reconciliation below ties each run's branches to its own
// independently committed step-7 split, so copying last report's branches
// fails validation whenever the split has moved.

export type Scenario = "bull" | "base" | "bear" | "crash";
export const SCENARIOS: Scenario[] = ["bull", "base", "bear", "crash"];
export type Split = Record<Scenario, number>;

export interface Branch extends Split {
  outcome: string;
  /** % likelihood of this outcome; branches of one event sum to 100. */
  probability: number;
}

export interface SubmittedEvent {
  event: string;
  event_date: string; // YYYY-MM-DD
  branches: Branch[];
}

export interface OpenPrediction extends SubmittedEvent {
  made_on: string;
  /** The run's unconditional step-7 split when this prediction was made. */
  unconditional_at_prediction: Split;
  /** Set when a run marked a due event "unresolved"; the event stays open and due. */
  last_unresolved?: { on: string; reason: string };
}

export interface OutcomeInput {
  event: string;
  event_date: string;
  /** A branch's outcome name, "other" (none of the branches happened), or "unresolved". */
  outcome: string;
  /** Required for "unresolved"; optional otherwise. */
  reason?: string;
}

export interface ScoringEntry {
  event: string;
  event_date: string;
  prediction_made_on: string;
  outcome: string;
  /** Probability the prediction gave the outcome that happened (0 for "other"). */
  outcome_probability: number;
  /** Branch split predicted for that outcome; null for "other". */
  predicted_split: Split | null;
  /** This run's committed step-7 split. */
  actual_split: Split;
  /** actual - predicted, per scenario, in points; null for "other". */
  change: Split | null;
  unconditional_at_prediction: Split;
  reason?: string;
  scored_on: string;
}

// Provisional limits (spec E8).
export const MAX_EVENTS_PER_RUN = 3;
export const MIN_BRANCHES = 2;
export const MAX_BRANCHES = 5;
export const SUM_TOLERANCE = 0.5;
export const RECONCILE_TOLERANCE_PTS = 5;
const RESERVED = new Set(["other", "unresolved"]);

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
export const eventKey = (e: { event: string; event_date: string }) => `${e.event_date}|${norm(e.event)}`;
const round1 = (n: number) => Math.round(n * 10) / 10;
const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const splitOf = (b: Split): Split => ({ bull: b.bull, base: b.base, bear: b.bear, crash: b.crash });

/** Validation errors for this run's submitted events (empty = valid). */
export function validateSubmitted(events: SubmittedEvent[], split: Split, today: string): string[] {
  const errors: string[] = [];
  if (events.length > MAX_EVENTS_PER_RUN) errors.push(`At most ${MAX_EVENTS_PER_RUN} events per run, got ${events.length}.`);
  const seen = new Set<string>();
  for (const e of events) {
    const label = `"${e.event}" (${e.event_date})`;
    if (!e.event.trim()) errors.push("An event needs a name.");
    if (!isDate(e.event_date)) { errors.push(`${label}: event_date must be YYYY-MM-DD.`); continue; }
    // Same-day prediction allowed (before the event); scoring is strictly after.
    if (e.event_date < today) errors.push(`${label}: event_date is in the past; predictions must be made on or before the event date.`);
    if (seen.has(eventKey(e))) errors.push(`${label}: submitted twice.`);
    seen.add(eventKey(e));
    if (e.branches.length < MIN_BRANCHES || e.branches.length > MAX_BRANCHES) {
      errors.push(`${label}: needs ${MIN_BRANCHES}-${MAX_BRANCHES} branches, got ${e.branches.length}.`);
      continue;
    }
    const names = new Set<string>();
    for (const b of e.branches) {
      const n = norm(b.outcome);
      if (!n) errors.push(`${label}: every branch needs an outcome name.`);
      if (RESERVED.has(n)) errors.push(`${label}: "${b.outcome}" is reserved for scoring; name the branch something else.`);
      if (names.has(n)) errors.push(`${label}: duplicate branch "${b.outcome}".`);
      names.add(n);
      const s = SCENARIOS.reduce((a, k) => a + b[k], 0);
      if (Math.abs(s - 100) > SUM_TOLERANCE) errors.push(`${label}, branch "${b.outcome}": bull+base+bear+crash must sum to 100, got ${round1(s)}.`);
    }
    const p = e.branches.reduce((a, b) => a + b.probability, 0);
    if (Math.abs(p - 100) > SUM_TOLERANCE) errors.push(`${label}: branch probabilities must sum to 100, got ${round1(p)}.`);
    else {
      for (const k of SCENARIOS) {
        const weighted = e.branches.reduce((a, b) => a + (b.probability / 100) * b[k], 0);
        if (Math.abs(weighted - split[k]) > RECONCILE_TOLERANCE_PTS) {
          errors.push(`${label}: probability-weighted ${k} is ${round1(weighted)} but this run's ${k} split is ${split[k]} (must be within ±${RECONCILE_TOLERANCE_PTS}pts).`);
        }
      }
    }
  }
  return errors;
}

/** Open predictions whose event date has passed: they need an outcome this run. */
export function dueEvents(open: OpenPrediction[], today: string): OpenPrediction[] {
  return open.filter((p) => p.event_date < today);
}

export interface ResolveResult {
  errors: string[];
  open: OpenPrediction[];
  scoring: ScoringEntry[];
}

/**
 * Merges the last full report's open predictions with this run's
 * submissions and outcomes. Rules: a due event (date strictly before today)
 * must get an outcome: a branch name or "other" scores it; "unresolved"
 * (with a reason) keeps it open and due without failing the write. A
 * not-yet-due open prediction is carried forward unless this run
 * re-submits the same event, which replaces it.
 */
export function resolveConditional(
  priorOpen: OpenPrediction[],
  submitted: SubmittedEvent[],
  outcomes: OutcomeInput[],
  split: Split,
  today: string,
): ResolveResult {
  const errors = validateSubmitted(submitted, split, today);
  const due = dueEvents(priorOpen, today);
  const dueKeys = new Map(due.map((p) => [eventKey(p), p]));
  const byKey = new Map<string, OutcomeInput>();
  for (const o of outcomes) {
    const k = eventKey(o);
    if (!dueKeys.has(k)) {
      errors.push(`Outcome given for "${o.event}" (${o.event_date}), but it isn't a due open prediction.`);
      continue;
    }
    byKey.set(k, o);
  }

  const scoring: ScoringEntry[] = [];
  const stillOpen: OpenPrediction[] = [];
  for (const p of due) {
    const o = byKey.get(eventKey(p));
    if (!o) {
      errors.push(
        `"${p.event}" (${p.event_date}) is due: give its outcome (one of: ${p.branches.map((b) => `"${b.outcome}"`).join(", ")}, "other"), ` +
          `or "unresolved" with a reason.`,
      );
      continue;
    }
    const name = norm(o.outcome);
    if (name === "unresolved") {
      if (!o.reason?.trim()) errors.push(`"${p.event}": outcome "unresolved" needs a reason.`);
      else stillOpen.push({ ...p, last_unresolved: { on: today, reason: o.reason.trim() } });
      continue;
    }
    const branch = p.branches.find((b) => norm(b.outcome) === name);
    if (!branch && name !== "other") {
      errors.push(`"${p.event}": outcome "${o.outcome}" matches no branch (${p.branches.map((b) => `"${b.outcome}"`).join(", ")}); use "other" if none happened.`);
      continue;
    }
    const predicted = branch ? splitOf(branch) : null;
    scoring.push({
      event: p.event,
      event_date: p.event_date,
      prediction_made_on: p.made_on,
      outcome: branch ? branch.outcome : "other",
      outcome_probability: branch ? branch.probability : 0,
      predicted_split: predicted,
      actual_split: { ...split },
      change: predicted ? (Object.fromEntries(SCENARIOS.map((k) => [k, round1(split[k] - predicted[k])])) as Split) : null,
      unconditional_at_prediction: p.unconditional_at_prediction,
      ...(o.reason?.trim() ? { reason: o.reason.trim() } : {}),
      scored_on: today,
    });
  }

  const submittedKeys = new Set(submitted.map(eventKey));
  const carried = priorOpen.filter((p) => p.event_date >= today && !submittedKeys.has(eventKey(p)));
  const fresh: OpenPrediction[] = submitted.map((e) => ({
    event: e.event.trim(),
    event_date: e.event_date,
    branches: e.branches,
    made_on: today,
    unconditional_at_prediction: { ...split },
  }));
  return { errors, open: [...stillOpen, ...carried, ...fresh], scoring };
}
