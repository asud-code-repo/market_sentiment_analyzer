// Run: npm test (node's built-in test runner via tsx -- no test framework dependency).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readInstructionDoc, INSTRUCTION_DOCUMENTS, type InstructionDocument } from "./instructionsDoc.js";

test("both workflow documents are readable from the working tree", () => {
  for (const doc of Object.keys(INSTRUCTION_DOCUMENTS) as InstructionDocument[]) {
    assert.ok(readInstructionDoc(doc).length > 1000, doc);
  }
});

test("the instructions name the workflows and point to the template via get_instructions", () => {
  const text = readInstructionDoc("project_instructions");
  for (const phrase of ["run crash check", "run portfolio review", "portfolio_review_template", "get_rules"]) {
    assert.ok(text.includes(phrase), phrase);
  }
  assert.ok(readInstructionDoc("portfolio_review_template").includes("<style>"));
});
