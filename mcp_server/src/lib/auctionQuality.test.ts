// Run: npm test (node's built-in test runner via tsx -- no test framework dependency).
import { test } from "node:test";
import assert from "node:assert/strict";
import { isWeakAuction } from "./auctionQuality.js";

test("weak only when BOTH bid-to-cover and indirect share are well below average", () => {
  // 2025-08-06 10Y: btc 2.35 vs 2.58, indirect 64.2 vs 72.3 -> weak
  assert.equal(isWeakAuction({ bid_to_cover: 2.35, indirect_pct: 64.2, prior_avg_bid_to_cover: 2.58, prior_avg_indirect_pct: 72.3 }), true);
  // btc weak, indirect fine
  assert.equal(isWeakAuction({ bid_to_cover: 2.3, indirect_pct: 71, prior_avg_bid_to_cover: 2.58, prior_avg_indirect_pct: 72.3 }), false);
  // indirect weak, btc fine
  assert.equal(isWeakAuction({ bid_to_cover: 2.5, indirect_pct: 60, prior_avg_bid_to_cover: 2.58, prior_avg_indirect_pct: 72.3 }), false);
  // 2026-10-07 10Y reopening: strong
  assert.equal(isWeakAuction({ bid_to_cover: 2.77, indirect_pct: 80.3, prior_avg_bid_to_cover: 2.54, prior_avg_indirect_pct: 74.1 }), false);
});

test("thresholds are strict: exactly 0.2 / 5pts below is not weak", () => {
  assert.equal(isWeakAuction({ bid_to_cover: 2.3, indirect_pct: 65, prior_avg_bid_to_cover: 2.5, prior_avg_indirect_pct: 70 }), false);
});

test("missing inputs are unknown (null), never 'not weak'", () => {
  assert.equal(isWeakAuction({ bid_to_cover: 2.2, indirect_pct: null, prior_avg_bid_to_cover: 2.5, prior_avg_indirect_pct: 70 }), null);
  assert.equal(isWeakAuction({ bid_to_cover: 2.2, indirect_pct: 60, prior_avg_bid_to_cover: null, prior_avg_indirect_pct: 70 }), null);
});
