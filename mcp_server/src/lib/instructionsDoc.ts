// Serves the Claude Desktop project's workflow documents from disk, the same
// way get_rules serves the rules doc (rulesDoc.ts).
//
// Why (2026-11-15): these used to reach Claude Desktop through the project's
// GitHub sync, which (a) only works while the repo is public, since the
// claude.ai GitHub connector lists public repos only, and (b) never
// refreshes on its own, so runs could follow a stale copy until someone
// clicked Sync. Read from this working tree instead, they're always the
// committed-and-deployed version the local MCP code was written against,
// whatever the repo's visibility.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RULES_DIR = path.resolve(fileURLToPath(import.meta.url), "../../../../reference_docs/rules");

export const INSTRUCTION_DOCUMENTS = {
  project_instructions: "project-instructions.md",
  portfolio_review_template: "portfolio-review-template.html",
} as const;

export type InstructionDocument = keyof typeof INSTRUCTION_DOCUMENTS;

export function instructionDocPath(doc: InstructionDocument): string {
  return path.join(RULES_DIR, INSTRUCTION_DOCUMENTS[doc]);
}

export function readInstructionDoc(doc: InstructionDocument): string {
  return readFileSync(instructionDocPath(doc), "utf8");
}
