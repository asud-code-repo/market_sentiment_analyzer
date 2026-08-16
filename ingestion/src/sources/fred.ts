import type { DataPoint } from "../lib/supabase.js";

// FRED API is stable and well documented: https://fred.stlouisfed.org/docs/api/fred/
// Series IDs below match the exact list in reference_docs/crash-check-system-build-spec.md
// (Stage 2 bullet) plus VIXCLS, which is the natural free source for the VIX
// reading used in the indicator panel (indicator #1).
const FRED_SERIES: { id: string; unit: string }[] = [
  { id: "VIXCLS", unit: "index" },       // CBOE Volatility Index
  { id: "BAMLH0A0HYM2", unit: "percent" }, // ICE BofA US High Yield OAS — FRED reports this in
                                          // percent (e.g. 2.90 = 290bps); the rule engine converts
                                          // to bps to match the indicator band units.
  { id: "DGS10", unit: "percent" },      // 10yr Treasury yield
  { id: "DGS2", unit: "percent" },       // 2yr Treasury yield
  { id: "DGS30", unit: "percent" },      // 30yr Treasury yield
  { id: "STLFSI4", unit: "index" },      // St. Louis Fed Financial Stress Index
  { id: "NFCI", unit: "index" },         // Chicago Fed National Financial Conditions Index
  { id: "T10YIE", unit: "percent" },     // 10yr breakeven inflation
  { id: "DRTSCILM", unit: "percent" },   // Senior Loan Officer Survey — C&I lending standards, large/medium firms
  { id: "RRPONTSYD", unit: "usd_billions" }, // Overnight reverse repo
  { id: "CPIAUCSL", unit: "index" },     // CPI, all urban consumers, headline
  { id: "UNRATE", unit: "percent" },     // Unemployment rate
  { id: "SAHMREALTIME", unit: "ratio" }, // Real-time Sahm Rule recession indicator

  // Track A additions — contextual/supplementary indicators (informational
  // only, not part of the 6-indicator wave-authorization gate; see
  // reference_docs/rules/crash-check-rules.md "Contextual Indicators").
  { id: "ICSA", unit: "count" },         // Initial jobless claims, weekly
  { id: "DRCCLACBS", unit: "percent" },  // Credit card delinquency rate, all commercial banks
  { id: "DCOILWTICO", unit: "usd" },     // WTI crude oil, $/barrel — automates the existing
                                          // "Brent/WTI above $100 = stagflation accelerant" line
                                          // in crash-check-rules.md's Recovery/Complacency bands.
  { id: "RSAFS", unit: "usd_millions" }, // Advance retail sales, all stores — closest free proxy
                                          // to "consumer/credit-card spending"; FRED has no public
                                          // real-time card-swipe series, this is reported monthly.
  { id: "CCSA", unit: "count" },         // Continuing jobless claims — pairs with ICSA (initial
                                          // claims) above. Flagged by external methodology review
                                          // 2026-07-16: initial claims can stay benign while
                                          // continuing claims trend upward, so watching only ICSA
                                          // misses the more informative half of the pair.
  { id: "BAMLC0A0CM", unit: "percent" }, // ICE BofA US Investment Grade OAS — pairs with the
                                          // existing HY spread (BAMLH0A0HYM2). IG spreads widening
                                          // while HY holds steady is an earlier quality-flight
                                          // signal than waiting for HY itself to move (external
                                          // review 2026-07-16). Same percent->bps convention as HY
                                          // applies when this is surfaced (see get_context_indicators).
  { id: "CGBD2024", unit: "percent" },   // Unemployment rate, college graduates w/ bachelor's
                                          // degree, 20-24yrs (BLS/CPS via FRED, monthly, not
                                          // seasonally adjusted). A structural/secular signal, not
                                          // cyclical — deliberately NOT part of the 6-indicator gate.
                                          // Closest FRED-native proxy to the NY Fed's own "recent
                                          // college grad" research (which isn't itself on FRED and
                                          // would need scraping to automate) — different age bracket
                                          // (20-24 vs NY Fed's 22-27) and methodology, same
                                          // underlying CPS survey. Worth cross-referencing with a
                                          // watchlist thesis re-underwrite for AI-trough-bet tickers,
                                          // not the crash panel (external review 2026-08-01).

  // CAD/USD FX rate for the RRSP's local_state/portfolio.yaml conversion —
  // was a hand-updated snapshot before this; see get_portfolio_snapshot in
  // mcp_server, which reads this series live instead of trusting the
  // hardcoded value. Units: Canadian dollars per 1 US dollar (e.g. 1.42) —
  // the CAD->USD rate used for value_usd is 1/DEXCAUS, computed at read time.
  { id: "DEXCAUS", unit: "cad_per_usd" },

  // 2026-08-15 additions — Section 5 of reference_docs/investment-model-review.md
  // flagged missing liquidity/credit-structure/global-transmission/valuation
  // indicators. These 6 are the ones that actually have real free FRED
  // history (verified against FRED's own series metadata, not guessed);
  // market breadth, realized vol as a sourced series, CDS indices,
  // cross-currency basis, and dealer balance sheets were checked and
  // confirmed to have no free FRED option, so they're left out rather than
  // force-fit to a weak proxy. All Tier 2/contextual — see
  // reference_docs/rules/crash-check-rules.md "Contextual Indicators".
  { id: "SOFR", unit: "percent" },       // Secured Overnight Financing Rate — repo-market
                                          // reference rate, spikes on repo/dollar-funding stress.
  { id: "DTWEXBGS", unit: "index" },     // Nominal Broad U.S. Dollar Index (Fed H.10, 26-currency
                                          // basket) — the "global transmission: dollar" leg.
  { id: "NFCIRISK", unit: "index" },     // Chicago Fed NFCI Risk Subindex — financial-sector
                                          // volatility/funding risk, a narrower cut of the
                                          // composite NFCI already tracked above.
  { id: "NFCICREDIT", unit: "index" },   // Chicago Fed NFCI Credit Subindex — broad
                                          // credit-tightness conditions specifically.
  { id: "DFII10", unit: "percent" },     // 10yr TIPS real yield — covers only the real-yield leg
                                          // of "equity valuation"; no free earnings-yield/CAPE
                                          // series exists on FRED, so this is a partial signal.
  // OECDLOLITOAASTSAM (OECD Composite Leading Indicator) was tried and
  // dropped 2026-08-16: its latest observation was frozen at 2022-11-01 —
  // not "monthly and lagged" as originally assumed, but years stale,
  // suggesting FRED has stopped updating/discontinued this series code.
  // Presenting a 4-year-old number as a live reading would be actively
  // misleading rather than merely weak signal, so it's left out entirely
  // rather than kept with a caveat.
];

interface FredObservation {
  date: string;
  value: string;
}

interface FredResponse {
  observations: FredObservation[];
}

// fetchFred() makes ~17 sequential requests per run; a bare fetch() means any
// single transient 5xx/network blip anywhere in that sequence aborts the
// entire FRED fetch (see fetchFred()'s atomic loop below), losing series that
// already succeeded too. Retries only 5xx/network errors — a 4xx (bad series
// ID, bad key) is a real bug and should still fail immediately, not be masked
// by retrying it.
const RETRY_DELAYS_MS = [500, 1500, 4000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(url: string): Promise<Response> {
  let lastError: Error = new Error("fetchWithRetry: unreachable");
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status < 500) return res;
      lastError = new Error(`HTTP ${res.status} ${await res.text()}`);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
    if (attempt < RETRY_DELAYS_MS.length) await sleep(RETRY_DELAYS_MS[attempt]);
  }
  throw lastError;
}

async function fetchLatestObservation(seriesId: string, apiKey: string): Promise<FredObservation> {
  const url = new URL("https://api.stlouisfed.org/fred/series/observations");
  url.searchParams.set("series_id", seriesId);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("file_type", "json");
  url.searchParams.set("sort_order", "desc");
  // FRED sometimes reports the most recent period as "." (not yet available) —
  // pull a few and take the first real value rather than assuming index 0 is valid.
  url.searchParams.set("limit", "5");

  const res = await fetchWithRetry(url.toString());
  if (!res.ok) {
    throw new Error(`FRED request failed for ${seriesId}: HTTP ${res.status} ${await res.text()}`);
  }

  const body = (await res.json()) as FredResponse;
  const observation = body.observations?.find((o) => o.value !== ".");
  if (!observation) {
    throw new Error(`FRED returned no usable observation for ${seriesId}`);
  }
  return observation;
}

// S&P drawdown-from-ATH is one of the 6 canonical indicators, but it needs
// two numbers FRED's "latest observation" pattern can't give us: today's
// level AND the running all-time-high. There's no "give me the max" FRED
// endpoint, so we fetch a multi-year window and compute both client-side.
// The window just needs to be long enough to contain the true ATH — FRED's
// SP500 series only goes back to 2013 anyway, and in a secular uptrend the
// ATH is usually recent, so this self-heals correctly on every run without
// needing a separate backfill step.
async function fetchSp500LevelAndAth(apiKey: string): Promise<DataPoint[]> {
  const url = new URL("https://api.stlouisfed.org/fred/series/observations");
  url.searchParams.set("series_id", "SP500");
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("file_type", "json");
  url.searchParams.set("observation_start", "2010-01-01");
  url.searchParams.set("sort_order", "asc");
  url.searchParams.set("limit", "100000");

  const res = await fetchWithRetry(url.toString());
  if (!res.ok) {
    throw new Error(`FRED request failed for SP500: HTTP ${res.status} ${await res.text()}`);
  }

  const body = (await res.json()) as FredResponse;
  const valid = body.observations?.filter((o) => o.value !== ".") ?? [];
  if (valid.length === 0) {
    throw new Error("FRED returned no usable SP500 observations");
  }

  const latest = valid[valid.length - 1];
  const ath = valid.reduce((max, o) => (Number(o.value) > Number(max.value) ? o : max), valid[0]);

  return [
    {
      series_id: "SP500",
      source: "FRED",
      source_series_code: "SP500",
      observation_date: latest.date,
      value: Number(latest.value),
      unit: "index",
      raw_payload: latest,
    },
    {
      // Derived, not a distinct FRED series — observation_date here is the
      // date the ATH was actually set, not today. Upserts idempotently on
      // (series_id, observation_date): stays a no-op update until a new
      // high actually prints, at which point the date moves forward.
      series_id: "SP500_ATH",
      source: "FRED_DERIVED",
      source_series_code: "SP500",
      observation_date: ath.date,
      value: Number(ath.value),
      unit: "index",
      raw_payload: { computed_from: "SP500 series max, 2010-present window", observation: ath },
    },
  ];
}

// One-time historical backfill (see backfill.ts). Originally capped at a
// rolling 5-years-back window, which covered the 2022 rate-hike cycle for
// the dashboard's trend charts but silently excluded 2008 and 2020 — the
// two most relevant crisis episodes for any future calibration/backtesting
// work (see reference_docs/investment-model-review.md). A fixed early
// anchor date costs nothing extra: FRED simply returns no observations
// before a series' actual inception, so each series naturally comes back
// with its own full available history (VIXCLS from 1990, CPIAUCSL/UNRATE
// from the late 1940s, etc). data_points reads are already paginated on the
// dashboard side, so this doesn't reintroduce the client-side bloat concern
// that originally motivated the 5-year cap.
//
// Verified 2026-08-16: BAMLH0A0HYM2/BAMLC0A0CM (HY/IG spreads) do NOT go
// back to 1996 despite that being their commonly-cited FRED inception —
// this repo's actual backfilled data only starts 2023-07-11/2023-07-17
// respectively, confirmed identically across two independent 1900-01-01-
// anchored backfill runs and a direct live query. Not an ingestion bug (the
// backfill script never runs plausibility filtering) — FRED's API itself
// only serves ~3 years for these two series IDs today, likely a licensing-
// driven restriction on ICE's underlying data. No amount of re-backfilling
// fixes this; it materially limits how far back credit-spread-based
// divergence/calibration work (see divergence.ts) can be checked.
const BACKFILL_START_DATE = "1900-01-01";

async function fetchFredHistory(seriesId: string, apiKey: string, observationStart: string): Promise<FredObservation[]> {
  const url = new URL("https://api.stlouisfed.org/fred/series/observations");
  url.searchParams.set("series_id", seriesId);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("file_type", "json");
  url.searchParams.set("observation_start", observationStart);
  url.searchParams.set("sort_order", "asc");
  url.searchParams.set("limit", "100000");

  const res = await fetchWithRetry(url.toString());
  if (!res.ok) {
    throw new Error(`FRED backfill request failed for ${seriesId}: HTTP ${res.status} ${await res.text()}`);
  }

  const body = (await res.json()) as FredResponse;
  return (body.observations ?? []).filter((o) => o.value !== ".");
}

export async function fetchFredBackfill(): Promise<DataPoint[]> {
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) {
    throw new Error("FRED_API_KEY is not set");
  }

  const startStr = BACKFILL_START_DATE;

  const points: DataPoint[] = [];
  for (const series of FRED_SERIES) {
    const history = await fetchFredHistory(series.id, apiKey, startStr);
    for (const obs of history) {
      points.push({
        series_id: series.id,
        source: "FRED",
        source_series_code: series.id,
        observation_date: obs.date,
        value: Number(obs.value),
        unit: series.unit,
        raw_payload: obs,
      });
    }
    console.log(`  FRED backfill: ${series.id} — ${history.length} observations since ${startStr}`);
  }

  // SP500 itself is a special case in the regular daily fetch (only the
  // latest level + running ATH get written, see fetchSp500LevelAndAth) — so
  // unlike every other FRED series, its daily history was never persisted.
  // This backfills the full daily level series so the dashboard can compute
  // a historical drawdown-from-ATH trend client-side (running max per date),
  // matching drawdownPct()'s formula in rule_engine/src/rules.ts.
  const sp500History = await fetchFredHistory("SP500", apiKey, startStr);
  for (const obs of sp500History) {
    points.push({
      series_id: "SP500",
      source: "FRED",
      source_series_code: "SP500",
      observation_date: obs.date,
      value: Number(obs.value),
      unit: "index",
      raw_payload: obs,
    });
  }
  console.log(`  FRED backfill: SP500 — ${sp500History.length} observations since ${startStr}`);

  return points;
}

export async function fetchFred(): Promise<DataPoint[]> {
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) {
    throw new Error("FRED_API_KEY is not set");
  }

  const points: DataPoint[] = [];
  for (const series of FRED_SERIES) {
    const obs = await fetchLatestObservation(series.id, apiKey);
    points.push({
      series_id: series.id,
      source: "FRED",
      source_series_code: series.id,
      observation_date: obs.date,
      value: Number(obs.value),
      unit: series.unit,
      raw_payload: obs,
    });
  }

  points.push(...(await fetchSp500LevelAndAth(apiKey)));

  return points;
}
