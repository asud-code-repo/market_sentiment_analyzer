const BASE_URL = "https://api.massive.com";
const apiKey = process.env.MASSIVE_API_KEY;
if (!apiKey) { console.error("MASSIVE_API_KEY not set"); process.exit(1); }

async function fetchJson(url) {
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) {
    console.log(`  FAILED: HTTP ${res.status} — ${text.slice(0, 400)}`);
    return null;
  }
  return JSON.parse(text);
}

async function checkOverview(symbol) {
  console.log(`\n=== ${symbol} ticker overview ===`);
  const url = new URL(`${BASE_URL}/v3/reference/tickers/${symbol}`);
  url.searchParams.set("apiKey", apiKey);
  const data = await fetchJson(url.toString());
  if (!data) return;
  const r = data.results || data;
  console.log(`  Full top-level keys: ${Object.keys(r).join(", ")}`);
  console.log(`  share_class_shares_outstanding: ${r.share_class_shares_outstanding}`);
  console.log(`  weighted_shares_outstanding: ${r.weighted_shares_outstanding}`);
  console.log(`  market_cap: ${r.market_cap}`);
  console.log(`  last updated / as-of fields present: ${JSON.stringify(Object.keys(r).filter(k => k.includes('date') || k.includes('updated') || k.includes('time')))}`);
}

for (const sym of ["SPY", "XLK", "XLF"]) {
  await checkOverview(sym);
}
