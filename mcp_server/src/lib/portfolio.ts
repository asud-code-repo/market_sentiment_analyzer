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
