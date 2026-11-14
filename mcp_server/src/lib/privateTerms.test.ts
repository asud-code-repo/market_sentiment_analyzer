// Run: npm test (node's built-in test runner via tsx -- no test framework dependency).
import { test } from "node:test";
import assert from "node:assert/strict";
import { findPrivateTerms } from "./privateTerms.js";

const TERMS = ["watchlist", "401(k)", "Example Plan", "SIP"];

test("finds whole-word terms case-insensitively, including punctuation in the term", () => {
  assert.deepEqual(findPrivateTerms("Watchlist: all WAIT.", TERMS), ["watchlist"]);
  assert.deepEqual(findPrivateTerms("hard rules (401(k) rotation suspended)", TERMS), ["401(k)"]);
  assert.deepEqual(findPrivateTerms("the example plan menu", TERMS), ["Example Plan"]);
});

test("ignores substrings inside other words", () => {
  assert.deepEqual(findPrivateTerms("Gossip about watchlists and SIPs", TERMS), []);
  assert.deepEqual(findPrivateTerms("Fed watch: no change", TERMS), []);
});

test("no terms configured means nothing is flagged", () => {
  assert.deepEqual(findPrivateTerms("watchlist", []), []);
});
