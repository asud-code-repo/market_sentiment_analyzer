// Plan excessive-trading restrictions (e.g. "1 day of exchanges per quarter,
// 12-month restriction period") and the exchange-day counting behind them.
// Pure, no I/O: the exchange log is read by exchangeLog.ts and passed in.
//
// Assumptions, all TBC with the plan and recorded in every status output:
// - "Quarter" = calendar quarter.
// - One multi-fund exchange submitted as one transaction = one exchange day;
//   further exchanges on an already-used day don't use another.
// - While covered_funds is "TBC", an exchange counts against an
//   instrument's limit only if it involves that instrument (or its funds are
//   unrecorded). `allPlanExchangesCount` is the worst case: every logged
//   exchange counts.
// - Missing start/end = restriction assumed in force today.

export interface TradeRestriction {
  policy: string;
  exchange_days_per_quarter: number | null;
  period_months?: number | null;
  start?: string | Date | null;
  end?: string | Date | null;
  covered_funds: string[] | "TBC";
}

export interface ExchangeEntry {
  date: string; // YYYY-MM-DD (or a synthetic "sim:..." day inside the fire drill)
  bought: string[];
  sold: string[];
  reason?: string;
}

/** Exchange days already in play for the transaction being evaluated. */
export interface ExchangeContext {
  quarterEntries: ExchangeEntry[]; // entries in the current quarter (plus simulated ones)
  ownDay: string; // the day this transaction would happen; same-day exchanges don't use a new day
  allPlanExchangesCount: boolean;
}

export interface RestrictionStatus {
  policy: string;
  in_force: boolean;
  quarter: string;
  days_allowed: number | null;
  days_used: string[];
  exhausted: boolean;
  covered_funds: string[] | "TBC";
  assumptions: string[];
}

export const UNKNOWN_FUND = "UNKNOWN";

export function isoDay(v: string | Date | null | undefined): string | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  return typeof v === "string" && v.length > 0 ? v : null;
}

export function quarterOf(d: Date): { label: string; start: string; end: string } {
  const y = d.getUTCFullYear();
  const q = Math.floor(d.getUTCMonth() / 3);
  const start = new Date(Date.UTC(y, q * 3, 1));
  const end = new Date(Date.UTC(y, q * 3 + 3, 0));
  return { label: `${y}-Q${q + 1}`, start: isoDay(start)!, end: isoDay(end)! };
}

export function entriesInQuarter(log: ExchangeEntry[], today: Date): ExchangeEntry[] {
  const q = quarterOf(today);
  return log.filter((e) => e.date >= q.start && e.date <= q.end);
}

export function exchangeContext(log: ExchangeEntry[], today: Date, allPlanExchangesCount = false): ExchangeContext {
  return { quarterEntries: entriesInQuarter(log, today), ownDay: isoDay(today)!, allPlanExchangesCount };
}

const norm = (s: string) => s.trim().toLowerCase();

function touches(entry: ExchangeEntry, names: Set<string>): boolean {
  return [...entry.bought, ...entry.sold].some((f) => norm(f) === norm(UNKNOWN_FUND) || names.has(norm(f)));
}

/** Identifiers an exchange-log entry might use for an instrument. */
export function instrumentNames(inst: { name: string; plan_name?: string; ticker?: string | null }): string[] {
  return [inst.plan_name, inst.ticker ?? undefined, inst.name].filter((x): x is string => !!x);
}

export function restrictionStatus(
  tr: TradeRestriction,
  names: string[],
  ctx: ExchangeContext,
  today: Date,
): RestrictionStatus {
  const todayIso = isoDay(today)!;
  const start = isoDay(tr.start);
  const end = isoDay(tr.end);
  const inForce = (!start || todayIso >= start) && (!end || todayIso <= end);
  const assumptions = [
    "quarter = calendar quarter",
    "one multi-fund exchange in one transaction = one exchange day",
  ];
  if (!start || !end) assumptions.push("start/end TBC — assumed in force");

  const nameSet = new Set(names.map(norm));
  let relevant: ExchangeEntry[];
  if (ctx.allPlanExchangesCount) {
    relevant = ctx.quarterEntries;
    assumptions.push("worst case: every plan exchange counts");
  } else if (tr.covered_funds === "TBC") {
    relevant = ctx.quarterEntries.filter((e) => touches(e, nameSet));
    assumptions.push("covered funds TBC — only exchanges involving this fund counted; others may also count");
  } else {
    for (const f of tr.covered_funds) nameSet.add(norm(f));
    relevant = ctx.quarterEntries.filter((e) => touches(e, nameSet));
  }
  const daysUsed = [...new Set(relevant.map((e) => e.date))].filter((d) => d !== ctx.ownDay).sort();
  const allowed = tr.exchange_days_per_quarter;
  if (allowed === null) assumptions.push("exchange-day limit unknown — not enforced");

  return {
    policy: tr.policy,
    in_force: inForce,
    quarter: quarterOf(today).label,
    days_allowed: allowed,
    days_used: daysUsed,
    exhausted: inForce && allowed !== null && daysUsed.length >= allowed,
    covered_funds: tr.covered_funds,
    assumptions,
  };
}

export function validateTradeRestriction(tr: unknown, where: string): string[] {
  const errors: string[] = [];
  const t = tr as Partial<TradeRestriction> | null;
  if (!t || typeof t !== "object") return [`${where}: trade_restrictions must be a mapping`];
  if (typeof t.policy !== "string" || !t.policy) errors.push(`${where}: trade_restrictions.policy missing`);
  if (t.exchange_days_per_quarter !== null && typeof t.exchange_days_per_quarter !== "number") {
    errors.push(`${where}: trade_restrictions.exchange_days_per_quarter must be a number or null`);
  }
  if (t.covered_funds !== "TBC" && !(Array.isArray(t.covered_funds) && t.covered_funds.every((f) => typeof f === "string"))) {
    errors.push(`${where}: trade_restrictions.covered_funds must be a list of fund names or "TBC"`);
  }
  for (const k of ["start", "end"] as const) {
    const v = t[k];
    if (v != null && (isoDay(v) === null || Number.isNaN(Date.parse(isoDay(v)! + "T00:00:00Z")))) {
      errors.push(`${where}: trade_restrictions.${k} is not YYYY-MM-DD`);
    }
  }
  return errors;
}
