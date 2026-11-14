import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { load, dump } from "js-yaml";
import type { DataPointRow } from "./supabase.js";

export interface WatchlistTicker {
  symbol: string;
  name: string;
  theme: string;
  wave1_target: number;
  wave2_target: number;
  wave3_target: number;
  wave3_only?: boolean;
  max_position_usd: number;
  thesis_note?: string;
}

export interface WatchlistFile {
  updated_at: string;
  updated_by?: string;
  tickers: WatchlistTicker[];
}

function watchlistPath(): string {
  // WATCHLIST_PATH if set, otherwise watchlist.yaml next to PORTFOLIO_PATH.
  const explicit = process.env.WATCHLIST_PATH;
  if (explicit) return explicit;
  const portfolio = process.env.PORTFOLIO_PATH;
  if (!portfolio) throw new Error("Neither WATCHLIST_PATH nor PORTFOLIO_PATH is set — see mcp_server/.env.example");
  return join(dirname(portfolio), "watchlist.yaml");
}

/**
 * Reads local_state/watchlist.yaml (or wherever WATCHLIST_PATH
 * points). Same trust boundary as portfolio.ts's readPortfolio() — never
 * touches the network, personal position sizing never leaves this machine.
 */
export function readWatchlist(): WatchlistFile {
  let raw: string;
  try {
    raw = readFileSync(watchlistPath(), "utf-8");
  } catch (err) {
    throw new Error(
      `Could not read watchlist file at ${watchlistPath()}. Copy ` +
        `local_state/watchlist.example.yaml to local_state/watchlist.yaml ` +
        `and fill in real values, or fix WATCHLIST_PATH. (${err})`,
    );
  }
  return load(raw) as WatchlistFile;
}

/**
 * Overwrites the watchlist file with a full replacement ticker list. Full
 * replacement (not a merge) keeps this simple and auditable — the caller
 * (write_watchlist tool) is expected to pass the complete updated list, not
 * a partial patch, so nothing silently disappears from a stale merge.
 */
export function writeWatchlist(tickers: WatchlistTicker[], updatedBy: string): WatchlistFile {
  const file: WatchlistFile = {
    updated_at: new Date().toISOString().slice(0, 10),
    updated_by: updatedBy,
    tickers,
  };
  writeFileSync(watchlistPath(), dump(file, { noRefs: true }), "utf-8");
  return file;
}

export type WatchlistStatus = "BUY_ZONE" | "WATCH" | "WAIT" | "NO_PRICE_DATA";

export interface WatchlistStatusEntry extends WatchlistTicker {
  current_price: number | null;
  price_as_of: string | null;
  pct_above_wave1: number | null;
  status: WatchlistStatus;
}

// Matches the exact bands from local_state/master-prompt-original.md's
// original watchlist design — preserved here as the deterministic
// replacement for Claude eyeballing "is this near its target" via web search.
function classifyStatus(pctAboveWave1: number): WatchlistStatus {
  if (pctAboveWave1 <= 0) return "BUY_ZONE";
  if (pctAboveWave1 <= 20) return "WATCH";
  return "WAIT";
}

export function computeWatchlistStatus(
  tickers: WatchlistTicker[],
  prices: (DataPointRow | null)[],
): WatchlistStatusEntry[] {
  return tickers.map((ticker, i) => {
    const price = prices[i];
    if (!price) {
      return { ...ticker, current_price: null, price_as_of: null, pct_above_wave1: null, status: "NO_PRICE_DATA" };
    }
    const pctAboveWave1 = Math.round(((price.value - ticker.wave1_target) / ticker.wave1_target) * 1000) / 10;
    return {
      ...ticker,
      current_price: price.value,
      price_as_of: price.observation_date,
      pct_above_wave1: pctAboveWave1,
      status: classifyStatus(pctAboveWave1),
    };
  });
}
