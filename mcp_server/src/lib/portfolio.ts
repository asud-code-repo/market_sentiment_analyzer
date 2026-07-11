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
