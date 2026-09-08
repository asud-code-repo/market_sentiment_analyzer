/**
 * Prints an approximate per-day token-cost readout for the "run crash
 * check" automation, built from mcp_server/src/lib/tokenLog.ts's NDJSON
 * log. Run manually — this is not an MCP tool, deliberately, so it costs
 * nothing in every run's context (the whole point of this instrumentation
 * is to make cost visible without adding more of it).
 *
 * Usage: npx tsx src/scripts/tokenUsageReport.ts [days]
 *   days — how many most-recent calendar days to show (default 7)
 *
 * What this does and doesn't capture:
 *   + MCP tool request/response payloads (the variable part — this is the
 *     only thing that was previously invisible).
 *   + The static floor: project-instructions.md + crash-check-rules.md +
 *     dashboard-template.html, sized fresh from disk each run of this
 *     script (so it doesn't silently go stale if those docs grow).
 *   - The MCP tool *schema* floor (names/descriptions/input schemas sent
 *     once per conversation) — approximated as a rough constant below;
 *     update it if server.ts's tool count/descriptions change materially.
 *   - Web research and the model's own completion (the rendered HTML
 *     artifact) — not observable from the MCP server at all.
 * Days are bucketed in America/New_York, matching ingest.yml's schedule
 * and freshness.ts's convention elsewhere in this project.
 */

import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { TOKEN_LOG_PATH } from "../lib/tokenLog.js";

// Rough, manually-maintained estimate of the MCP tool schema floor (14
// tools' name+description+inputSchema, trimmed 2026-09-08: ~13.3K chars /
// ~3,500 tokens, down from ~20.3K/~5,350 pre-trim). Re-measure if tools
// change materially — see backlog_token_cost_trimming memory for the
// char-counting approach used to get this number.
const MCP_SCHEMA_FLOOR_TOKENS = 3500;

const RULES_DIR = path.resolve(fileURLToPath(import.meta.url), "../../../../reference_docs/rules");
const STATIC_DOCS = ["project-instructions.md", "crash-check-rules.md", "dashboard-template.html"];

function easternDateString(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(
    date,
  );
}

function staticFloorTokens(): number {
  let chars = 0;
  for (const doc of STATIC_DOCS) {
    try {
      chars += statSync(path.join(RULES_DIR, doc)).size;
    } catch {
      // Doc missing/renamed — floor estimate just under-counts it.
    }
  }
  return Math.ceil(chars / 4) + MCP_SCHEMA_FLOOR_TOKENS;
}

interface LogEntry {
  ts: string;
  tool: string;
  approx_input_tokens: number;
  approx_output_tokens: number;
}

function readEntries(): LogEntry[] {
  let raw: string;
  try {
    raw = readFileSync(TOKEN_LOG_PATH, "utf-8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as LogEntry);
}

function main() {
  const days = Number(process.argv[2]) || 7;
  const entries = readEntries();
  if (entries.length === 0) {
    console.log(`No entries yet in ${TOKEN_LOG_PATH} — run a crash check first.`);
    return;
  }

  const byDay = new Map<string, { toolTokens: number; byTool: Map<string, number> }>();
  for (const e of entries) {
    const day = easternDateString(new Date(e.ts));
    if (!byDay.has(day)) byDay.set(day, { toolTokens: 0, byTool: new Map() });
    const bucket = byDay.get(day)!;
    const tokens = e.approx_input_tokens + e.approx_output_tokens;
    bucket.toolTokens += tokens;
    bucket.byTool.set(e.tool, (bucket.byTool.get(e.tool) ?? 0) + tokens);
  }

  const floor = staticFloorTokens();
  const sortedDays = [...byDay.keys()].sort().reverse().slice(0, days);

  console.log(`Static floor per run (docs + tool schemas, measured fresh from disk): ~${floor.toLocaleString()} tokens\n`);
  for (const day of sortedDays) {
    const { toolTokens, byTool } = byDay.get(day)!;
    console.log(`${day} — tool round-trips ~${toolTokens.toLocaleString()} tokens, floor+tools ~${(floor + toolTokens).toLocaleString()} tokens`);
    for (const [tool, tokens] of [...byTool.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${tool.padEnd(28)} ~${tokens.toLocaleString()}`);
    }
  }
  console.log(
    "\nNote: excludes web research and the model's own completion (the rendered dashboard artifact) — " +
      "real per-run total will be higher than floor+tools.",
  );
}

main();
