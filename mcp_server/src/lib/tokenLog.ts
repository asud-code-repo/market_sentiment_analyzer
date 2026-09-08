/**
 * Approximate per-run token-cost visibility. The daily automation runs via
 * a Claude Desktop scheduled task (subscription billing), not the Anthropic
 * API, so there is no Console usage entry for it — this is the only way to
 * see what a run actually cost. chars/4 is a rough proxy for tokenization,
 * not exact, and only covers MCP tool request/response payloads — it does
 * not capture the static project-knowledge/tool-schema floor, web research,
 * or the model's own completion (see tokenUsageReport.ts for how those are
 * layered back in).
 *
 * Logged locally only (local_state/ is gitignored, matching the rest of
 * this project's split-storage boundary) — this is operational metadata,
 * not personal financial data, but there's no reason to route it through
 * Supabase either.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const LOG_DIR = path.resolve(fileURLToPath(import.meta.url), "../../../../local_state");
export const TOKEN_LOG_PATH = path.join(LOG_DIR, "token_usage_log.ndjson");

export function logTokenUsage(tool: string, input: unknown, output: unknown): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    const inputChars = input ? JSON.stringify(input).length : 0;
    const outputChars = JSON.stringify(output).length;
    const entry = {
      ts: new Date().toISOString(),
      tool,
      approx_input_tokens: Math.ceil(inputChars / 4),
      approx_output_tokens: Math.ceil(outputChars / 4),
    };
    appendFileSync(TOKEN_LOG_PATH, JSON.stringify(entry) + "\n");
  } catch {
    // Best-effort instrumentation — a logging failure must never break the
    // actual tool call it's observing.
  }
}
