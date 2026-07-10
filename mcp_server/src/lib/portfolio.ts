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
