import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { load, dump } from "js-yaml";
import { isoDay, UNKNOWN_FUND, type ExchangeEntry } from "./tradeRestrictions.js";

/**
 * local_state/exchange_log.yaml — every 401k exchange actually submitted
 * (wave or not), so plan excessive-trading limits ("1 exchange day per
 * quarter") can be counted. Same trust boundary as portfolio.ts:
 * local-only, gitignored. Path is EXCHANGE_LOG_PATH if set, otherwise
 * exchange_log.yaml next to PORTFOLIO_PATH. A missing file = no exchanges yet.
 */
function exchangeLogPath(): string {
  const explicit = process.env.EXCHANGE_LOG_PATH;
  if (explicit) return explicit;
  const portfolio = process.env.PORTFOLIO_PATH;
  if (!portfolio) throw new Error("Neither EXCHANGE_LOG_PATH nor PORTFOLIO_PATH is set — see mcp_server/.env.example");
  return join(dirname(portfolio), "exchange_log.yaml");
}

function toList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string" && v) return [v];
  return [];
}

export function readExchangeLog(): ExchangeEntry[] {
  const path = exchangeLogPath();
  if (!existsSync(path)) return [];
  const raw = load(readFileSync(path, "utf-8")) as { exchanges?: unknown[] } | null;
  const entries: ExchangeEntry[] = [];
  for (const [i, e] of (raw?.exchanges ?? []).entries()) {
    const r = e as Record<string, unknown>;
    const date = isoDay(r.date as string | Date | null);
    if (!date || Number.isNaN(Date.parse(date + "T00:00:00Z"))) {
      throw new Error(`exchange_log.yaml entry ${i + 1}: date is not YYYY-MM-DD`);
    }
    const bought = toList(r.bought);
    const sold = toList(r.sold);
    entries.push({
      date,
      // An entry with no funds recorded counts against every restriction.
      bought: bought.length || sold.length ? bought : [UNKNOWN_FUND],
      sold,
      reason: typeof r.reason === "string" ? r.reason : undefined,
    });
  }
  return entries.sort((a, b) => a.date.localeCompare(b.date));
}

/** Appends one exchange (full-file rewrite, same pattern as wave state). */
export function appendExchange(entry: ExchangeEntry): ExchangeEntry[] {
  const log = readExchangeLog();
  log.push(entry);
  log.sort((a, b) => a.date.localeCompare(b.date));
  const header =
    "# Local-only, gitignored. Every 401k exchange actually submitted (wave or not),\n" +
    "# used to count plan excessive-trading exchange days. Edit by hand or via the\n" +
    "# record_exchange / record_wave_deployment tools. One multi-fund transaction = one entry.\n";
  writeFileSync(exchangeLogPath(), header + dump({ exchanges: log }, { noRefs: true, lineWidth: 120 }), "utf-8");
  return log;
}
