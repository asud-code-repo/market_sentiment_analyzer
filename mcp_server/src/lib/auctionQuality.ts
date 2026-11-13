// Weak-auction flag for 10Y and 30Y Treasury auctions (E4, 2026-11-13;
// crash-check-rules.md "Treasury auction quality (10Y/30Y)"). Context only:
// never feeds red_count, confirmed_red_count or wave logic.
//
// PROVISIONAL threshold: an auction is weak when BOTH its bid-to-cover is
// more than 0.2 below, AND its indirect-bidder share (% of competitive
// accepted) more than 5 percentage points below, the average of that
// tenor's previous 6 auctions, reopenings included. Free when-issued yields
// aren't available, so this stands in for the usual "tail" measure.
//
// Base rate, Fiscal Data auctions 2015-01..2026-10 (reopenings included):
// 10Y 5 of 138 auctions (3.6%), 30Y 3 of 136 (2.2%) — e.g. Nov 2016,
// Aug 2020 (30Y), Aug 2025 (10Y). Either condition alone fires far more
// often (indirect alone: 12-18%), so requiring both keeps it selective.
// Descriptive (this auction was weak), not a forecast; not backtested
// against market outcomes.
export const WEAK_AUCTION_BTC_BELOW_AVG = 0.2;
export const WEAK_AUCTION_INDIRECT_PTS_BELOW_AVG = 5;
export const WEAK_AUCTION_TENORS = ["10Y", "30Y"] as const;

export interface AuctionQualityInput {
  bid_to_cover: number;
  indirect_pct: number | null;
  prior_avg_bid_to_cover: number | null;
  prior_avg_indirect_pct: number | null;
}

/** true = weak; false = not weak; null = a needed number is missing (unknown, never "not weak"). */
export function isWeakAuction(a: AuctionQualityInput): boolean | null {
  if (a.indirect_pct === null || a.prior_avg_bid_to_cover === null || a.prior_avg_indirect_pct === null) return null;
  return (
    a.bid_to_cover < a.prior_avg_bid_to_cover - WEAK_AUCTION_BTC_BELOW_AVG &&
    a.indirect_pct < a.prior_avg_indirect_pct - WEAK_AUCTION_INDIRECT_PTS_BELOW_AVG
  );
}
