const BASE_URL = "https://api.massive.com";
const apiKey = process.env.MASSIVE_API_KEY;
if (!apiKey) { console.error("MASSIVE_API_KEY not set"); process.exit(1); }

async function fetchJson(url) {
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) {
    console.log(`  FAILED: HTTP ${res.status} — ${text.slice(0, 300)}`);
    return null;
  }
  return JSON.parse(text);
}

function toDateStr(d) { return d.toISOString().slice(0, 10); }

async function checkTicker(symbol) {
  console.log(`\n=== ${symbol} ===`);

  const to = new Date();
  const from = new Date();
  from.setFullYear(from.getFullYear() - 1);
  const fromStr = toDateStr(from);
  const toStr = toDateStr(to);

  // Price range (same endpoint fetchTickerRange already uses)
  const priceUrl = new URL(`${BASE_URL}/v2/aggs/ticker/${symbol}/range/1/day/${fromStr}/${toStr}`);
  priceUrl.searchParams.set("apiKey", apiKey);
  priceUrl.searchParams.set("sort", "asc");
  priceUrl.searchParams.set("limit", "500");
  const priceData = await fetchJson(priceUrl.toString());
  if (!priceData || !priceData.results || priceData.results.length === 0) {
    console.log(`  No price data returned.`);
    return;
  }
  const bars = priceData.results;
  const firstClose = bars[0].c;
  const lastClose = bars[bars.length - 1].c;
  console.log(`  Price bars: ${bars.length}, from ${toDateStr(new Date(bars[0].t))} ($${firstClose}) to ${toDateStr(new Date(bars[bars.length-1].t))} ($${lastClose})`);
  const priceReturnPct = ((lastClose - firstClose) / firstClose) * 100;
  console.log(`  Price-only return: ${priceReturnPct.toFixed(2)}%`);

  // Dividends endpoint
  const divUrl = new URL(`${BASE_URL}/stocks/v1/dividends`);
  divUrl.searchParams.set("ticker", symbol);
  divUrl.searchParams.set("apiKey", apiKey);
  divUrl.searchParams.set("limit", "50");
  divUrl.searchParams.set("sort", "ex_dividend_date.desc");
  const divData = await fetchJson(divUrl.toString());
  if (!divData) {
    console.log(`  Dividends endpoint failed for ${symbol}.`);
    return;
  }
  const divResults = divData.results || divData.data || [];
  console.log(`  Dividends endpoint raw shape (first result keys): ${divResults[0] ? Object.keys(divResults[0]).join(", ") : "no results field found — full body keys: " + Object.keys(divData).join(", ")}`);
  console.log(`  Total dividend records returned: ${divResults.length}`);
  console.log(`  First 5 records (date, ticker, amount): ${divResults.slice(0, 5).map(d => `${d.ex_dividend_date}/${d.ticker}/$${d.cash_amount}`).join(" | ")}`);

  // Filter to trailing 1yr window using whatever date field is present
  const dateField = divResults[0] ? (divResults[0].ex_dividend_date ? "ex_dividend_date" : Object.keys(divResults[0]).find(k => k.includes("date"))) : null;
  const amountField = divResults[0] ? (divResults[0].cash_amount !== undefined ? "cash_amount" : Object.keys(divResults[0]).find(k => k.toLowerCase().includes("amount") || k.toLowerCase().includes("cash"))) : null;
  console.log(`  Using date field "${dateField}", amount field "${amountField}"`);

  if (dateField && amountField) {
    const inWindow = divResults.filter(d => d[dateField] >= fromStr && d[dateField] <= toStr);
    const totalDivs = inWindow.reduce((sum, d) => sum + (d[amountField] || 0), 0);
    console.log(`  Dividends in trailing 1yr window: ${inWindow.length}, sum = $${totalDivs.toFixed(4)}`);
    const totalReturnPct = ((lastClose - firstClose + totalDivs) / firstClose) * 100;
    console.log(`  Approx total return (price + simple dividend sum, not reinvested): ${totalReturnPct.toFixed(2)}%`);
  } else {
    console.log(`  Could not identify date/amount fields — raw first record: ${JSON.stringify(divResults[0])}`);
  }
}

await checkTicker("SPY");
await checkTicker("TLT");
