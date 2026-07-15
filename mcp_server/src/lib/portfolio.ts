import { readFileSync } from "node:fs";
import { load } from "js-yaml";

/**
 * Reads local_state/portfolio.yaml (or wherever PORTFOLIO_PATH points).
 * This file never touches the network — it's read here, merged into the
 * chat response by Claude, and never written back anywhere. See
 * reference_docs/rules/crash-check-rules.md for the split-storage rationale.
 */
export function readPortfolio(): unknown {
  const path = process.env.PORTFOLIO_PATH;
  if (!path) {
    throw new Error("PORTFOLIO_PATH is not set — see mcp_server/.env.example");
  }

  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    throw new Error(
      `Could not read portfolio file at ${path}. Copy local_state/portfolio.example.yaml to ` +
        `local_state/portfolio.yaml and fill in real values, or fix PORTFOLIO_PATH. (${err})`,
    );
  }

  return load(raw);
}

/**
 * Safely extracts accounts.tactical_401k.dry_powder_usd from the parsed
 * portfolio file, without assuming its shape beyond that one path — the
 * rest of the file is free-form and read directly by Claude via
 * get_portfolio_snapshot, not parsed by code.
 */
export function readDryPowderUsd(): number {
  const portfolio = readPortfolio();
  const value = (portfolio as Record<string, unknown> | null)?.["accounts"];
  const tactical401k = (value as Record<string, unknown> | undefined)?.["tactical_401k"];
  const dryPowder = (tactical401k as Record<string, unknown> | undefined)?.["dry_powder_usd"];

  if (typeof dryPowder !== "number") {
    throw new Error(
      "Could not find accounts.tactical_401k.dry_powder_usd in the portfolio file — " +
        "check its structure against local_state/portfolio.example.yaml.",
    );
  }
  return dryPowder;
}

/**
 * Overrides the RRSP's hardcoded value_usd/fx_rate_* fields with a live
 * computation from FRED's DEXCAUS series (Canadian dollars per 1 US dollar
 * — the CAD->USD rate is 1/dexcausValue), and recomputes the two combined
 * totals that depend on it. Returns the original portfolio unchanged if the
 * expected shape isn't found, so a structure mismatch degrades to "report
 * the stale hardcoded snapshot" rather than throwing and losing the whole
 * get_portfolio_snapshot response over one field.
 */
export function applyLiveFxRate(
  portfolio: unknown,
  dexcausValue: number,
  asOfDate: string,
): unknown {
  const root = portfolio as Record<string, unknown> | null;
  const accounts = root?.["accounts"] as Record<string, unknown> | undefined;
  const rrsp = accounts?.["passive_long_duration_account"] as Record<string, unknown> | undefined;
  const combined = root?.["combined"] as Record<string, unknown> | undefined;
  const valueCad = rrsp?.["value_cad"];

  if (!rrsp || typeof valueCad !== "number" || !combined || dexcausValue <= 0) {
    return portfolio;
  }

  const cadToUsdRate = Math.round((1 / dexcausValue) * 10000) / 10000;
  const rrspValueUsd = Math.round(valueCad * cadToUsdRate);
  const rrspValueUsdOld = rrsp["value_usd"];
  const shiftUsd = typeof rrspValueUsdOld === "number" ? rrspValueUsd - rrspValueUsdOld : 0;

  const updatedRrsp = {
    ...rrsp,
    fx_rate_cad_to_usd: cadToUsdRate,
    fx_rate_as_of: asOfDate,
    fx_rate_source: "FRED DEXCAUS (live, via get_portfolio_snapshot)",
    value_usd: rrspValueUsd,
  };

  const updatedCombined = { ...combined };
  for (const key of ["total_equity_at_risk_incl_passive_usd", "combined_value_ex_sip_usd"]) {
    const prior = updatedCombined[key];
    if (typeof prior === "number") updatedCombined[key] = prior + shiftUsd;
  }

  return {
    ...root,
    accounts: { ...accounts, passive_long_duration_account: updatedRrsp },
    combined: updatedCombined,
  };
}

/**
 * Recursively collects every numeric value whose key name marks it as a
 * dollar figure (ends in `_usd`/`_cad`) — deliberately narrow rather than
 * grabbing every number in the file, so percentages/rates/allocation
 * weights (e.g. nyl_anchor_rate: 0.0395, holdings_pct: 65.5) don't cause
 * false-positive matches against legitimate macro content already in real
 * reports (e.g. "$725B in AI capex", "Brent ~$77"). Also excludes anything
 * under $1,000 — small figures like a $500 monthly contribution are both
 * less sensitive and more likely to coincidentally collide with an
 * unrelated small number in narrative text.
 */
function extractDollarFigures(node: unknown, out: Set<number> = new Set()): Set<number> {
  if (node === null || typeof node !== "object") return out;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (typeof value === "number" && /_usd$|_cad$/.test(key) && Math.abs(value) >= 1000) {
      out.add(Math.round(value));
    } else if (typeof value === "object" && value !== null) {
      extractDollarFigures(value, out);
    }
  }
  return out;
}

/**
 * Scans `text` for any of the portfolio's real dollar figures appearing as
 * a standalone number (not just a substring inside a larger, unrelated
 * number — e.g. matching "175678" inside "1756780"), in either raw
 * ("175678") or comma-formatted ("175,678") form. Returns the matched
 * figures, or an empty array if none leaked. This is the guardrail behind
 * write_snapshot/any future write path that persists free-text content —
 * see reference_docs/rules/crash-check-rules.md's split-storage note: no
 * personal dollar figure should ever reach Supabase, and that shouldn't
 * rely on prompt-following alone.
 */
export function findLeakedDollarFigures(text: string, portfolio: unknown): number[] {
  const figures = extractDollarFigures(portfolio);
  const found: number[] = [];
  for (const figure of figures) {
    const raw = String(figure);
    const formatted = figure.toLocaleString("en-US");
    const pattern = new RegExp(`(?<!\\d)(${raw}|${formatted})(?!\\d)`);
    if (pattern.test(text)) {
      found.push(figure);
    }
  }
  return found;
}

export interface DriftEntry {
  fund: string;
  actual_pct: number;
  target_pct: number;
  drift_pts: number;
  status: "ON_TARGET" | "DRIFTED";
}

export interface AccountDrift {
  account_key: string;
  label: string;
  entries: DriftEntry[];
  max_drift_pts: number;
  has_drifted: boolean;
}

// Matches the rebalancing-band convention used by mainstream robo-advisors
// (Betterment/Wealthfront-style drift monitoring): flag a fund once it's off
// its long-term target by more than this many percentage points, rather than
// rebalancing on every tiny wiggle.
const DRIFT_THRESHOLD_PTS = 5;

/**
 * Compares actual holdings_pct against long_term_target_pct for every
 * account that defines both, flagging funds drifted beyond
 * DRIFT_THRESHOLD_PTS. Deliberately mechanical — no macro judgment, purely
 * "is this account still close to its own stated target." Accounts with no
 * formal target (e.g. the RRSP's permanent passive stance) are simply
 * skipped; accounts with a known structural_issue note but no formal target
 * (e.g. spouse 401k) surface that note as a standing flag instead of
 * fabricating a target that was never specified.
 *
 * Accounts with an active dry_powder_usd mechanism (currently just the
 * tactical 401k) are also skipped here: their "distance from long-term
 * target" is dominated by dry powder deliberately held back per the
 * crash-protocol wave system, not neglect — a raw target-vs-actual diff
 * can't tell those apart and would flag a huge, fully-intentional "drift"
 * every single run. That account's rebalancing pace is already governed by
 * get_deployment_plan/wave status, so it's noted as a pointer instead.
 */
export function computePortfolioDrift(portfolio: unknown): {
  accounts: AccountDrift[];
  standing_flags: string[];
} {
  const root = portfolio as Record<string, unknown> | null;
  const accounts = (root?.["accounts"] as Record<string, unknown> | undefined) ?? {};
  const result: AccountDrift[] = [];
  const standingFlags: string[] = [];

  for (const [key, acctRaw] of Object.entries(accounts)) {
    const acct = acctRaw as Record<string, unknown>;
    const holdings = acct["holdings_pct"] as Record<string, number> | undefined;
    const target = acct["long_term_target_pct"] as Record<string, number> | undefined;
    const label = typeof acct["label"] === "string" ? (acct["label"] as string) : key;

    if (typeof acct["dry_powder_usd"] === "number") {
      standingFlags.push(
        `${label}: rebalancing pace is governed by the crash-protocol wave system, not a plain drift check — see get_deployment_plan for wave-gated deployment status instead.`,
      );
    } else if (holdings && target) {
      const funds = new Set([...Object.keys(holdings), ...Object.keys(target)]);
      const entries: DriftEntry[] = [...funds].map((fund) => {
        const actual = holdings[fund] ?? 0;
        const tgt = target[fund] ?? 0;
        const drift = Math.round((actual - tgt) * 10) / 10;
        return {
          fund,
          actual_pct: actual,
          target_pct: tgt,
          drift_pts: drift,
          status: Math.abs(drift) > DRIFT_THRESHOLD_PTS ? "DRIFTED" : "ON_TARGET",
        };
      });
      entries.sort((a, b) => Math.abs(b.drift_pts) - Math.abs(a.drift_pts));
      result.push({
        account_key: key,
        label,
        entries,
        max_drift_pts: entries.length > 0 ? Math.max(...entries.map((e) => Math.abs(e.drift_pts))) : 0,
        has_drifted: entries.some((e) => e.status === "DRIFTED"),
      });
    } else if (typeof acct["structural_issue"] === "string") {
      standingFlags.push(`${label}: ${acct["structural_issue"]}`);
    }
  }

  return { accounts: result, standing_flags: standingFlags };
}
