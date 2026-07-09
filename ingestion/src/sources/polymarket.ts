import type { DataPoint } from "../lib/supabase.js";

// Polymarket Gamma API — public, no key required. Verified live 2026-07-09:
// GET https://gamma-api.polymarket.com/markets?slug=<slug> returns an array
// with one market object. Confirmed response fields: `outcomes` and
// `outcomePrices` are both JSON-encoded string arrays, e.g.
// outcomes: '["Yes","No"]', outcomePrices: '["0.515","0.485"]'.
//
// Market slugs are NOT stable series IDs — they're tied to a specific,
// time-bound market (e.g. a market resolving "by Dec 2026" gets replaced by
// a new slug next cycle). Configure the slugs you want tracked via the
// POLYMARKET_SLUGS env var (comma-separated). Leave unset/empty to skip
// this source entirely — it's the only ingestion source that's optional by
// design, since there's no fixed set of "the" relevant markets.
const GAMMA_MARKETS_URL = "https://gamma-api.polymarket.com/markets";

interface GammaMarket {
  slug: string;
  question: string;
  outcomes: string; // JSON-encoded string[]
  outcomePrices: string; // JSON-encoded string[], parallel to outcomes
  active: boolean;
  closed: boolean;
}

async function fetchMarketBySlug(slug: string): Promise<GammaMarket> {
  const url = new URL(GAMMA_MARKETS_URL);
  url.searchParams.set("slug", slug);

  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`Polymarket request failed for slug "${slug}": HTTP ${res.status}`);
  }

  const body = (await res.json()) as GammaMarket[];
  const market = body[0];
  if (!market) {
    throw new Error(`Polymarket returned no market for slug "${slug}" — has it resolved/expired?`);
  }
  return market;
}

export async function fetchPolymarket(): Promise<DataPoint[]> {
  const slugsRaw = process.env.POLYMARKET_SLUGS?.trim();
  if (!slugsRaw) {
    return []; // optional source — nothing configured, nothing to fetch
  }

  const slugs = slugsRaw.split(",").map((s) => s.trim()).filter(Boolean);
  const today = new Date().toISOString().slice(0, 10);
  const points: DataPoint[] = [];

  for (const slug of slugs) {
    const market = await fetchMarketBySlug(slug);
    const outcomes: string[] = JSON.parse(market.outcomes);
    const prices: string[] = JSON.parse(market.outcomePrices);
    const yesIdx = outcomes.findIndex((o) => o.toLowerCase() === "yes");
    const probability = yesIdx >= 0 ? Number(prices[yesIdx]) : Number(prices[0]);

    points.push({
      series_id: `POLYMARKET_${slug.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`,
      source: "POLYMARKET",
      source_series_code: slug,
      observation_date: today,
      value: probability,
      unit: "probability",
      raw_payload: { question: market.question, outcomes, prices },
    });
  }
  return points;
}
