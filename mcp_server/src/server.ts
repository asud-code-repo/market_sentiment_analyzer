import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getRecentCrashChecks, getLatestCrashCheckWithProbability, writeSnapshot, writeFullReport, writePortfolioReview, refreshFullReportWatchlist, getLatestDataPoint, syncWatchlistTickers } from "./lib/supabase.js";
import { readPortfolio, readDryPowderUsd, applyLiveFxRate, computePortfolioDrift, computeRateResetTriggerStatus } from "./lib/portfolio.js";
import { computeDelta } from "./lib/delta.js";
import { computeWaveDeployment, computeCrashTypeLayer, type Wave, type CrashType } from "./lib/waveDeployment.js";
import { readWaveDeploymentState, recordWaveDeployment } from "./lib/waveDeploymentState.js";
import { readWatchlist, writeWatchlist, computeWatchlistStatus } from "./lib/watchlist.js";
import { computeSeriesDelta } from "./lib/seriesDelta.js";
import { computeDataFreshness } from "./lib/freshness.js";
import { estrellaMishkinRecessionProbability } from "./lib/recessionProbability.js";
import { computeFedEventTrigger, computeInflationPrintTrigger } from "./lib/economicCalendar.js";
import { computeSectorRotation } from "./lib/sectorRotation.js";
import { logTokenUsage } from "./lib/tokenLog.js";

const server = new McpServer({ name: "crash-check", version: "1.0.0" });

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

// Wraps a tool handler to log its approximate request/response size — see
// tokenLog.ts and `npm run usage-report` for why (Desktop scheduled-task
// billing has no per-run token visibility the way API traffic would).
// Deliberately loose (`any`) rather than generic over the handler's real
// input/output types — it's a transparent side-channel, not part of the
// zod-validated request/response contract each tool already has.
function withLogging(name: string, handler: (...args: any[]) => Promise<any>) {
  return async (...args: any[]) => {
    const result = await handler(...args);
    logTokenUsage(name, args[0], result);
    return result;
  };
}

server.registerTool(
  "get_latest_snapshot",
  {
    description:
      "Returns the most recent crash_checks row plus a delta vs the last row that actually had a " +
      "probability (the last full report, not just the last row — most rows are bare automated " +
      "refreshes). Call only after independently committing to this run's probability estimate — " +
      "this is for the delta-log framing, not for forming the estimate itself. `risk_radar` (when " +
      "present) is the prior run's discretionary macro-risk read (see crash-check-rules.md's 'Risk " +
      "Radar Scoring Methodology') -- same tier as crash_probability_pct, never gates, useful here " +
      "only as a reference point for this run's own risk_radar judgment.",
  },
  withLogging("get_latest_snapshot", async () => {
    const [latest] = await getRecentCrashChecks(1);
    if (!latest) {
      return json({ error: "No crash_checks rows exist yet — has the rule engine (Stage 3) run?" });
    }
    const prior = await getLatestCrashCheckWithProbability();
    // Exclude latest itself if it's already the row with the probability
    // (e.g. this tool called twice in one session) — delta should compare
    // against a genuinely prior report, not itself.
    const priorForDelta = prior && prior.id !== latest.id ? prior : undefined;
    return json({ latest, delta: computeDelta(latest, priorForDelta) });
  }),
);

server.registerTool(
  "get_indicator_panel",
  {
    description:
      "Returns the 6-indicator RED/AMBER/GREEN panel, red_count/confirmed_red_count, and wave status. " +
      "wave_authorized already reflects confirmed_red_count (see crash-check-rules.md's Signal Tiering " +
      "rule) — report that as the authorizing number, not raw red_count. Check data_freshness.is_fresh " +
      "before proceeding (project-instructions.md step 1). hazard_model_10pct is a separate rule-engine-" +
      "computed estimate, not the same as your own crash_probability_pct judgment (see write_snapshot) — " +
      "report its band, not a re-derived percentage.",
  },
  withLogging("get_indicator_panel", async () => {
    const [latest] = await getRecentCrashChecks(1);
    if (!latest) {
      return json({ error: "No crash_checks rows exist yet — has the rule engine (Stage 3) run?" });
    }
    // Freshness must reflect the actual core observations, not just this
    // row's own generated timestamp (see freshness.ts, F06) — fetch each
    // core series' latest data_points row directly rather than trusting
    // raw_source_data or the report's run_at alone.
    const CORE_SERIES: { series_id: string; cadence: "daily" | "monthly" }[] = [
      { series_id: "VIXCLS", cadence: "daily" },
      { series_id: "BAMLH0A0HYM2", cadence: "daily" },
      { series_id: "SP500", cadence: "daily" },
      { series_id: "DGS10", cadence: "daily" },
      { series_id: "SAHMREALTIME", cadence: "monthly" },
    ];
    const corePoints = await Promise.all(CORE_SERIES.map((s) => getLatestDataPoint(s.series_id)));
    const coreSeriesFreshness = CORE_SERIES.map((s, i) => {
      const point = corePoints[i];
      return point ? { series_id: s.series_id, cadence: s.cadence, observation_date: point.observation_date } : null;
    }).filter((s): s is { series_id: string; cadence: "daily" | "monthly"; observation_date: string } => s !== null);
    const conf = latest.confirmation_state ?? {};
    const withConfirmation = (key: string, value: unknown, color: string | null) => ({
      value,
      color,
      confirmed: conf[key]?.confirmed ?? null,
      days_confirmed: conf[key]?.days_confirmed ?? null,
      first_breach_date: conf[key]?.first_breach_date ?? null,
    });
    return json({
      run_at: latest.run_at,
      data_freshness: computeDataFreshness(latest.run_at, coreSeriesFreshness),
      indicators: {
        vix: withConfirmation("vix", latest.vix_value, latest.vix_color),
        hy_spread_bps: withConfirmation("hy_spread", latest.hy_spread_bps, latest.hy_spread_color),
        sp_drawdown_pct: withConfirmation("sp_drawdown", latest.sp_drawdown_pct, latest.sp_drawdown_color),
        treasury_10y_pct: withConfirmation("treasury_10y", latest.treasury_10y_pct, latest.treasury_10y_color),
        sahm_rule: withConfirmation("sahm_rule", latest.sahm_rule_value, latest.sahm_rule_color),
        // No confirmation entry — manually/LLM-judged, no numeric series behind it (see tool description).
        fed_pivot_signal: { value: latest.fed_pivot_signal, color: latest.fed_pivot_color },
      },
      red_count: latest.red_count,
      confirmed_red_count: latest.confirmed_red_count,
      wave_authorized: latest.wave_authorized,
      wave_active: latest.wave_active,
      // FAST_PANIC (drawdown+VIX, the original rule) or SLOW_BEAR (drawdown
      // depth + a fresh trailing low, added 2026-09-19 for crises where
      // price damage is severe but volatility never spikes — see
      // crash-check-rules.md); null when wave_active is NONE.
      wave_active_reason: latest.wave_active_reason,
      sp500_level: latest.sp500_level,
      sp500_ath: latest.sp500_ath,
      sp500_ath_date: latest.sp500_ath_date,
      hazard_model_10pct: {
        status: latest.hazard_10pct_status,
        calibrated_pct: latest.hazard_10pct_calibrated_pct,
        band: latest.hazard_10pct_band,
        raw_pct: latest.hazard_10pct_raw_pct,
        as_of: latest.hazard_10pct_as_of,
        signal:
          "Rule-engine-computed and calibrated — distinct from crash_probability_pct (100% LLM " +
          "judgment, see write_snapshot). Report the BAND, never a re-derived percentage or a blend " +
          "with your own estimate (see crash-check-rules.md's Statistical Hazard Model section for " +
          "why: steppy calibration curve, plateau structure). Check status before reporting a band: " +
          "ALREADY_BREACHED means live drawdown is already >=10%, so the model's target (a FUTURE " +
          "breach conditional on not already being past it) doesn't apply — say the threshold is " +
          "already breached, not a fresh-breach percentage. UNAVAILABLE means this run's computation " +
          "failed (a required input series was missing) — treat as unavailable, not a reading of " +
          "zero. Only ELIGIBLE carries a meaningful band.",
      },
    });
  }),
);

server.registerTool(
  "get_trigger_status",
  {
    description:
      "Returns personal decision trigger status (fired/approaching/pending), the Warsh Fed " +
      "classification, and fed_event_trigger/inflation_print_trigger — computed here from a " +
      "maintained calendar (economicCalendar.ts), not your memory. current_target_date/label identify " +
      "which FOMC/CPI event is current; you still judge the qualitative outcome (hawkish/dovish, " +
      "beat/miss). If calendar_needs_update is true, tell the user rather than guessing a date. " +
      "Earnings-guidance dates are deliberately excluded (no fixed public schedule) — stays your call.",
  },
  withLogging("get_trigger_status", async () => {
    const [latest] = await getRecentCrashChecks(1);
    if (!latest) {
      return json({ error: "No crash_checks rows exist yet — has the rule engine (Stage 3) run?" });
    }
    return json({
      trigger_status: latest.trigger_status,
      warsh_classification: latest.warsh_classification,
      warsh_classification_date: latest.warsh_classification_date,
      warsh_hard_rules_active: latest.warsh_hard_rules_active,
      fed_event_trigger: computeFedEventTrigger(),
      inflation_print_trigger: computeInflationPrintTrigger(),
    });
  }),
);

server.registerTool(
  "get_portfolio_snapshot",
  {
    description:
      "Returns personal account balances/allocations from the local portfolio file — never read " +
      "from or written to Supabase. RRSP CAD->USD conversion uses a live FRED DEXCAUS rate (public " +
      "macro data, not the resulting personal figure). rate_reset_trigger.status ('fired'/'pending') " +
      "is a plain date comparison, already evaluated here — use it directly in get_trigger_status/" +
      "write_snapshot rather than recomputing the date comparison yourself, which has repeatedly " +
      "produced wrong results in practice.",
  },
  withLogging("get_portfolio_snapshot", async () => {
    const portfolio = readPortfolio();
    const rateResetTrigger = computeRateResetTriggerStatus(portfolio);
    const dexcaus = await getLatestDataPoint("DEXCAUS");
    if (!dexcaus) {
      // No live rate available yet (e.g. ingestion hasn't run since this
      // series was added) — fall back to the file's hardcoded snapshot
      // rather than failing the whole tool call.
      return json({ ...(portfolio as object), rate_reset_trigger: rateResetTrigger });
    }
    const withFx = applyLiveFxRate(portfolio, dexcaus.value, dexcaus.observation_date);
    return json({ ...(withFx as object), rate_reset_trigger: rateResetTrigger });
  }),
);

server.registerTool(
  "get_portfolio_drift",
  {
    description:
      "Compares holdings_pct against long_term_target_pct per account, flagging drift beyond each " +
      "fund's own threshold_pts (5/25 rule: whichever is smaller of 5pts absolute or 25% of that " +
      "fund's target, floored at 2pts — self-scaling, since a 5pt drift matters far more on a 5% " +
      "target than a 30% one). Purely mechanical; the threshold is computed here, not to be " +
      "recomputed. The tactical 401k's dry-powder fund appears with a standing_flag explaining its " +
      "deliberate deviation (wave-gated, not neglect); accounts with a known structural_issue but no " +
      "formal target (e.g. spouse 401k) get a standing flag too.",
  },
  withLogging("get_portfolio_drift", async () => json(computePortfolioDrift(readPortfolio()))),
);

server.registerTool(
  "get_watchlist_status",
  {
    description:
      "Returns the BrokerageLink stock watchlist with live price vs. Wave 1/2/3 targets and a " +
      "deterministic BUY_ZONE/WATCH/WAIT status per ticker. Prices come from Supabase (ingested " +
      "daily via Alpha Vantage); targets/thesis/sizing come from the local watchlist file. Purely " +
      "mechanical — use this instead of estimating prices via web search.",
  },
  withLogging("get_watchlist_status", async () => {
    const watchlist = readWatchlist();
    const prices = await Promise.all(watchlist.tickers.map((t) => getLatestDataPoint(t.symbol)));
    return json({
      updated_at: watchlist.updated_at,
      tickers: computeWatchlistStatus(watchlist.tickers, prices),
    });
  }),
);

server.registerTool(
  "get_series_deltas",
  {
    description:
      "Returns 3-day and 7-day calendar-day deltas (not check-to-check gaps) for one or more " +
      "data_points series, fulfilling crash-check-rules.md's Delta standard — previously no tool " +
      "exposed historical lookback values, so deltas could not be computed at all. Looks up the most " +
      "recent value on or before each target date (markets/FRED don't publish every calendar day), " +
      "anchored to the series' own latest observation date, not 'today'. For the 6-indicator panel " +
      "pass series_ids: VIXCLS, BAMLH0A0HYM2 (already converted to bps here, matching " +
      "get_indicator_panel's hy_spread_bps — do not re-multiply), SP500, DGS10, SAHMREALTIME " +
      "(Fed pivot signal has no numeric series, no delta possible). For the watchlist pass each " +
      "ticker symbol. Returns null for a horizon if no data exists that far back yet — report as " +
      "unavailable, never estimate or fabricate a delta yourself. Note: SAHMREALTIME publishes " +
      "monthly, so its delta reflects change since the last available monthly reading, not a literal " +
      "3/7 calendar-day window — mention that caveat if reporting it.",
    inputSchema: {
      series_ids: z.array(z.string()).min(1),
    },
  },
  withLogging("get_series_deltas", async (input) => {
    const deltas = await Promise.all(input.series_ids.map((id: string) => computeSeriesDelta(id)));
    return json({ deltas });
  }),
);

server.registerTool(
  "write_watchlist",
  {
    description:
      "Persists an updated BrokerageLink watchlist — full replacement of the ticker list, not a " +
      "merge. Writes targets/thesis/position sizing to the local file, and syncs just the ticker " +
      "symbols to Supabase's watchlist_tickers table (public data, no dollar figures) so ingestion " +
      "picks up new/removed tickers automatically on the next run — no separate manual step. Use " +
      "this after an on-demand 'run portfolio review' session once the user has approved specific " +
      "changes. Never call this to record a routine price check — only for actual reviewed changes.",
    inputSchema: {
      tickers: z.array(
        z.object({
          symbol: z.string(),
          name: z.string(),
          theme: z.string(),
          wave1_target: z.number().positive(),
          wave2_target: z.number().positive(),
          wave3_target: z.number().positive(),
          wave3_only: z.boolean().optional(),
          max_position_usd: z.number().positive(),
          thesis_note: z.string().optional(),
        }),
      ),
      change_summary: z.string(),
    },
  },
  withLogging("write_watchlist", async (input) => {
    const written = writeWatchlist(input.tickers, `Claude (portfolio review): ${input.change_summary}`);
    await syncWatchlistTickers(input.tickers.map((t: { symbol: string }) => t.symbol));
    // Keeps the Full Report page's cached watchlist table from going stale
    // relative to this change — otherwise it'd only refresh on the next
    // write_full_report call (during "run crash check"), potentially days
    // later, contradicting whatever a Portfolio Review just wrote about it.
    await refreshFullReportWatchlist(input.tickers);
    return json({ written });
  }),
);

server.registerTool(
  "write_snapshot",
  {
    description:
      "Persists this run's qualitative synthesis (crash probability, scenario distribution, " +
      "narrative notes, delta log) back to Supabase, combined with the current indicator panel/wave " +
      "status from the latest rule-engine row. `delta_log` should be the same structured list of " +
      "factors you're already rendering in the HTML artifact's colored delta log (each " +
      "{sign: 'pos'|'neg', text}) — this was previously only ever rendered live and never persisted, " +
      "which is why the public dashboard couldn't show it; omit it entirely on a run with no prior " +
      "full report to diff against. `trigger_status` is automatically deduplicated server-side, " +
      "keeping only the latest entry (by `date`) per canonical trigger type (Fed-event/inflation-" +
      "print/earnings-guidance/rate-reset, matched by name prefix) — you don't need to manually " +
      "remove superseded entries yourself. When a trigger's target rolls to a new occurrence, " +
      "either replace the old entry in place or simply append a new one; the server keeps whichever " +
      "has the later date. fed-event/inflation-print entries also get their `status` forced to " +
      "'fired' server-side once their own `date` is today or in the past, regardless of what you " +
      "supply -- you still write the qualitative outcome in `note` (was it hawkish/dovish, in-line " +
      "or a beat/miss), just don't worry about the status enum lagging behind it. `risk_radar` " +
      "(geopolitical/policy_fed/inflation/valuation/labor_market/" +
      "earnings, each 0-100) is required every run — see crash-check-rules.md's 'Risk Radar Scoring " +
      "Methodology' for the per-axis banded rubric (4 of the 6 axes anchor to real series already " +
      "tracked in this system; geopolitical/earnings stay narrative-only, no free anchoring data " +
      "exists for either). Discretionary like crash_probability_pct -- never gates, never validated. " +
      "crash_probability_pct must fall within [scenario_crash_pct, scenario_bear_pct + scenario_crash_pct] " +
      "-- the headline number can't undercut your own dedicated Crash-bucket estimate, and can't exceed " +
      "Bear+Crash combined (crash is the most severe scenario, a subset of that broader stress zone, not " +
      "something that can outweigh it). Keep the two judgments consistent with each other when you commit " +
      "to both in step 7. Do not include any personal dollar figures in `notes` — " +
      "this is written to Supabase, which holds macro/rule state only.",
    inputSchema: {
      crash_probability_pct: z.number().min(0).max(100),
      crash_probability_low_pct: z.number().min(0).max(100),
      crash_probability_high_pct: z.number().min(0).max(100),
      scenario_bull_pct: z.number().min(0).max(100),
      scenario_base_pct: z.number().min(0).max(100),
      scenario_bear_pct: z.number().min(0).max(100),
      scenario_crash_pct: z.number().min(0).max(100),
      risk_radar: z.object({
        geopolitical: z.number().min(0).max(100),
        policy_fed: z.number().min(0).max(100),
        inflation: z.number().min(0).max(100),
        valuation: z.number().min(0).max(100),
        labor_market: z.number().min(0).max(100),
        earnings: z.number().min(0).max(100),
      }),
      notes: z.string(),
      delta_log: z
        .array(
          z.object({
            sign: z.enum(["pos", "neg"]),
            text: z.string(),
          }),
        )
        .optional(),
      crash_type: z.enum(["A_STAGFLATION", "B_RECESSION", "C_CREDIT", "D_AI_BUBBLE", "E_HYBRID"]).nullable().optional(),
      warsh_classification: z.enum(["HAWKISH", "MODERATE", "DOVISH", "PENDING"]).optional(),
      warsh_classification_date: z.string().optional(),
      warsh_hard_rules_active: z.boolean().optional(),
      fed_pivot_signal: z.enum(["NONE", "PAUSE", "CUT"]).optional(),
      trigger_status: z
        .array(
          z.object({
            name: z.string(),
            date: z.string(),
            status: z.enum(["fired", "approaching", "pending"]),
            note: z.string().nullable().optional(),
          }),
        )
        .optional(),
    },
  },
  withLogging("write_snapshot", async (input) => {
    const scenarioSum =
      input.scenario_bull_pct + input.scenario_base_pct + input.scenario_bear_pct + input.scenario_crash_pct;
    if (Math.abs(scenarioSum - 100) > 0.5) {
      return json({ error: `Scenario distribution must sum to 100, got ${scenarioSum}` });
    }
    // Previously only each bound's own 0-100 range was checked (zod), not
    // their relative ordering — a range like low=40/point=20/high=30 would
    // write successfully despite being internally inconsistent (external
    // review 2026-09-19, F09).
    if (!(input.crash_probability_low_pct <= input.crash_probability_pct && input.crash_probability_pct <= input.crash_probability_high_pct)) {
      return json({
        error:
          `crash_probability range must satisfy low <= point <= high, got ` +
          `low=${input.crash_probability_low_pct} point=${input.crash_probability_pct} high=${input.crash_probability_high_pct}`,
      });
    }
    // Added 2026-09-20 (user question: the headline % and the scenario
    // distribution are committed together but had no enforced relationship
    // to each other — crash_probability_pct could contradict the scenario
    // breakdown it's supposed to summarize). "Crash" is the most severe of
    // the 4 scenario buckets, so the headline crash probability shouldn't
    // undercut Claude's own dedicated Crash-bucket estimate (lower bound),
    // and shouldn't exceed Bear-or-worse combined, since a crash is a
    // subset of that broader stress zone, not something that can outweigh
    // it (upper bound). This is a new internal-consistency convention, not
    // a rediscovered original rule — crash-check-rules.md's own "Crash-
    // Probability Scoring Methodology" section is explicitly deferred/draft
    // and never specified this relationship.
    const scenarioBearOrWorse = input.scenario_bear_pct + input.scenario_crash_pct;
    if (!(input.scenario_crash_pct <= input.crash_probability_pct && input.crash_probability_pct <= scenarioBearOrWorse)) {
      return json({
        error:
          `crash_probability_pct must fall within [scenario_crash_pct, scenario_bear_pct + scenario_crash_pct], got ` +
          `point=${input.crash_probability_pct}, scenario_crash_pct=${input.scenario_crash_pct}, ` +
          `bear+crash=${scenarioBearOrWorse}`,
      });
    }
    const row = await writeSnapshot(input);
    return json({ written: row });
  }),
);

server.registerTool(
  "get_context_indicators",
  {
    description:
      "Returns supplementary macro context — financial stress/conditions indices, breakeven " +
      "inflation, bank lending standards, reverse repo, 2s10s curve, jobless claims, credit-card " +
      "delinquencies, WTI, retail sales, IG credit spread, SOFR, broad dollar index, NFCI " +
      "sub-indices, TIPS real yield, two external recession-probability models, small-cap " +
      "breadth, gold price (GLD), copper price, Bitcoin price, and sector capital-rotation. " +
      "Informational only — never part of the 6-indicator wave-authorization gate. gold_price is " +
      "directional context for the existing Type C/Type E sleeve allocation, not a new signal. " +
      "copper_price_usd_per_ton is an informational leading-indicator cross-check for the Type B " +
      "(Recession) crash-type diagnosis — not one of that diagnosis's hard trigger criteria " +
      "(unemployment/Sahm/CPI), which stay unchanged; monthly cadence (IMF-sourced), not daily. " +
      "bitcoin_price is tracked for " +
      "awareness only — verified NOT a crash hedge (fell more than equities in both 2020 and 2022) " +
      "— never treat it as confirming or contradicting the crash thesis. sector_rotation gives real " +
      "creation/redemption flow (not a price proxy) for the 11 sector SPDRs + SPY + GLD, but only " +
      "at the ETF-vehicle level — see its own signal field for the full caveat. " +
      "divergence_flags is computed once daily by the rule engine and persisted on the latest " +
      "crash_checks row (see crash-check-rules.md's Cross-Indicator Divergence section for what each " +
      "pair means) — report as-is, never re-judge from the raw numbers. recent_grad_unemployment_" +
      "rate_pct likely reflects both structural (AI/remote-work displacement) and cyclical factors -- " +
      "this measurement alone can't separate the two; not treated as a crash-timing signal either " +
      "way — see project-instructions.md's NVDA thesis step for how to use it. hires_rate_pct " +
      "(JTSHIR) pairs with initial/continuing jobless claims -- claims measure layoffs, hires rate " +
      "measures whether people are finding new jobs, together a fuller labor-market read than " +
      "claims alone. The two recession-probability " +
      "fields are external published models (Chauvet-Piger; NY Fed Estrella-Mishkin) — calibration " +
      "cross-checks only, never validation of your own estimate. effective_fed_funds_rate_pct " +
      "(DFF) is the Fed's own overnight rate -- distinct from the market-priced yield_curve_2s10s/" +
      "thirty_year_treasury_pct series above. federal_debt_pct_gdp (GFDEGDQ188S) is quarterly and " +
      "lags by design -- the structural debt-load backdrop behind a \"fiscal dominance\" read (rate " +
      "levels/borrowing overriding the usual yield-vs-equity relationship), added 2026-09-22.",
  },
  withLogging("get_context_indicators", async () => {
    const [stlfsi4, nfci, t10yie, drtscilm, rrpontsyd, dgs10, dgs2, dgs30, dgs3mo, icsa, ccsa, jtshir, drcclacbs, wti, retailSales, bamlIg, recentGradUnemployment, sofr, dtwexbgs, nfciRisk, nfciCredit, dfii10, recessionProbSmoothed, copper, dff, debtToGdp, iwmDelta, spyDelta, goldDelta, bitcoinDelta, sectorRotation, [latestCrashCheck]] =
      await Promise.all([
        getLatestDataPoint("STLFSI4"),
        getLatestDataPoint("NFCI"),
        getLatestDataPoint("T10YIE"),
        getLatestDataPoint("DRTSCILM"),
        getLatestDataPoint("RRPONTSYD"),
        getLatestDataPoint("DGS10"),
        getLatestDataPoint("DGS2"),
        getLatestDataPoint("DGS30"),
        getLatestDataPoint("DGS3MO"),
        getLatestDataPoint("ICSA"),
        getLatestDataPoint("CCSA"),
        getLatestDataPoint("JTSHIR"),
        getLatestDataPoint("DRCCLACBS"),
        getLatestDataPoint("DCOILWTICO"),
        getLatestDataPoint("RSAFS"),
        getLatestDataPoint("BAMLC0A0CM"),
        getLatestDataPoint("CGBD2024"),
        getLatestDataPoint("SOFR"),
        getLatestDataPoint("DTWEXBGS"),
        getLatestDataPoint("NFCIRISK"),
        getLatestDataPoint("NFCICREDIT"),
        getLatestDataPoint("DFII10"),
        getLatestDataPoint("RECPROUSM156N"),
        getLatestDataPoint("PCOPPUSDM"),
        getLatestDataPoint("DFF"),
        getLatestDataPoint("GFDEGDQ188S"),
        computeSeriesDelta("IWM"),
        computeSeriesDelta("SPY"),
        computeSeriesDelta("GLD"),
        computeSeriesDelta("X:BTCUSD"),
        computeSectorRotation(),
        getRecentCrashChecks(1),
      ]);
    const divergenceFlags = latestCrashCheck?.divergence_flags ?? [];

    // Small-cap vs. large-cap breadth proxy (Russell 2000 via IWM vs. S&P 500
    // via SPY) — no raw advance/decline or %-above-200dma series exists for
    // free, so relative ETF return is the closest available signal. Same
    // "simple derived value, computed live here" pattern as yieldCurve2s10s
    // below, not persisted via rule_engine/divergence.ts (that pattern ANDs
    // two independent absolute-threshold booleans, which doesn't fit a
    // relative-return spread).
    const pctChange = (latest: number | null, delta: number | null): number | null => {
      if (latest === null || delta === null) return null;
      const past = latest - delta;
      return past === 0 ? null : ((latest - past) / past) * 100;
    };
    const round2 = (n: number) => Math.round(n * 100) / 100;
    const iwmPct7d = pctChange(iwmDelta.latest_value, iwmDelta.delta_7d);
    const spyPct7d = pctChange(spyDelta.latest_value, spyDelta.delta_7d);
    const breadthSpread7d = iwmPct7d !== null && spyPct7d !== null ? round2(iwmPct7d - spyPct7d) : null;
    const smallCapBreadth =
      breadthSpread7d !== null
        ? {
            spread_7d_pct: breadthSpread7d,
            iwm_pct_change_7d: round2(iwmPct7d!),
            spy_pct_change_7d: round2(spyPct7d!),
            as_of: iwmDelta.latest_date,
            signal:
              "Russell 2000 (IWM) vs S&P 500 (SPY) relative 7-day return, a free breadth proxy " +
              "(no raw advance/decline or %-above-200dma series exists for free). Negative = " +
              "small-caps underperforming — small-caps are more exposed to domestic credit " +
              "conditions and floating-rate debt, so persistent underperformance can be an early " +
              "stress signal before it shows up in large-cap earnings. Informational only, Tier 2 " +
              "— never part of the 3-of-6 wave-authorization gate. Threshold/magnitude is a first " +
              "cut, not backtested — read directionally, not as a hard flag.",
          }
        : null;

    // Gold and Bitcoin, added 2026-09-14. Both informational-only, never
    // part of the 3-of-6 wave-authorization gate — same tier as
    // small_cap_breadth above.
    const goldPct7d = pctChange(goldDelta.latest_value, goldDelta.delta_7d);
    const goldPrice =
      goldDelta.latest_value !== null
        ? {
            value_usd: goldDelta.latest_value,
            pct_change_7d: goldPct7d !== null ? round2(goldPct7d) : null,
            as_of: goldDelta.latest_date,
            signal:
              "GLD (SPDR Gold Shares) as a gold-price proxy. Gold already has a real allocation in " +
              "the Type C (6.96%) and Type E (4.35%) crash-type sleeves (crash-check-rules.md Stage 3) " +
              "— tracked here as live directional context for that existing allocation, not a new " +
              "signal. Historically NOT a universal hedge: sold off alongside equities during the " +
              "acute margin-call/liquidity-panic phase of 2008 before rallying later once the " +
              "monetary response kicked in — don't read a decline here as automatically contradicting " +
              "the crash thesis.",
          }
        : null;

    const bitcoinPct7d = pctChange(bitcoinDelta.latest_value, bitcoinDelta.delta_7d);
    const bitcoinPrice =
      bitcoinDelta.latest_value !== null
        ? {
            value_usd: bitcoinDelta.latest_value,
            pct_change_7d: bitcoinPct7d !== null ? round2(bitcoinPct7d) : null,
            as_of: bitcoinDelta.latest_date,
            signal:
              "Tracked for awareness only — NOT a defensive/hedge asset. Verified against actual " +
              "crash-period data (2026-09-14): BTC fell 40-58% in the March 2020 COVID crash (vs " +
              "S&P -30 to -35%) and 77% in the 2022 bear market (vs S&P -25%/Nasdaq -33%) — higher-beta " +
              "than equities in both of this system's real crash episodes, not a hedge. Never treat a " +
              "BTC decline as confirming, or a BTC rally as contradicting, the crash thesis.",
          }
        : null;

    const twoTenSpread =
      dgs10 && dgs2
        ? {
            value_pct: Math.round((dgs10.value - dgs2.value) * 100) / 100,
            as_of: dgs10.observation_date,
            signal: dgs10.value - dgs2.value < 0 ? "INVERTED — historically precedes recessions" : "normal (positive slope)",
          }
        : null;

    // NY Fed's published Estrella-Mishkin (1998) formula, evaluated here
    // (not scraped) — see mcp_server/src/lib/recessionProbability.ts.
    const nyFedRecessionProb =
      dgs10 && dgs3mo
        ? {
            value_pct: Math.round(estrellaMishkinRecessionProbability(dgs10.value - dgs3mo.value) * 10) / 10,
            as_of: dgs10.observation_date,
            spread_10y_3mo_pct: Math.round((dgs10.value - dgs3mo.value) * 100) / 100,
            signal: "external published model (NY Fed, Estrella-Mishkin 1998) — a calibration cross-check, not validation of your own estimate. Uses today's spot DGS10/DGS3MO, not the NY Fed's own monthly-average convention -- a known, flagged approximation.",
          }
        : null;

    return json({
      financial_stress_index: stlfsi4 && { ...stlfsi4, signal: stlfsi4.value > 0 ? "above-average stress" : "below-average stress" },
      national_financial_conditions: nfci && { ...nfci, signal: nfci.value > 0 ? "tighter than average" : "looser than average" },
      breakeven_inflation_10y: t10yie,
      bank_lending_standards_tightening_pct: drtscilm && { ...drtscilm, signal: drtscilm.value > 0 ? "net tightening" : drtscilm.value < 0 ? "net easing" : "net unchanged" },
      reverse_repo_usd_billions: rrpontsyd,
      yield_curve_2s10s: twoTenSpread,
      initial_jobless_claims: icsa,
      continuing_jobless_claims: ccsa && { ...ccsa, signal: "see divergence_flags.initial_vs_continuing_claims for the computed divergence read against initial_jobless_claims" },
      hires_rate_pct: jtshir && { ...jtshir, signal: "read alongside initial/continuing jobless claims -- claims measure layoffs, hires rate measures whether people are finding new jobs. A falling hires rate alongside flat claims can mask a hiring slowdown claims alone wouldn't show." },
      credit_card_delinquency_rate_pct: drcclacbs,
      wti_crude_usd_per_barrel: wti && { ...wti, signal: wti.value > 100 ? "above $100 — stagflation accelerant watch" : "below $100" },
      retail_sales_usd_millions: retailSales,
      ig_credit_spread_bps: bamlIg && {
        value: Math.round(bamlIg.value * 100 * 10) / 10,
        observation_date: bamlIg.observation_date,
        signal: "see divergence_flags.ig_vs_hy_credit_spread for the computed divergence read against the gating HY spread",
      },
      recent_grad_unemployment_rate_pct: recentGradUnemployment && {
        ...recentGradUnemployment,
        signal: "likely reflects both structural factors (AI + remote-work displacement of entry-level hiring) and cyclical labor-market softness -- this measurement alone can't separate the two. Not treated as a crash-timing signal either way, but ambiguous evidence for the NVDA 'AI recovery trough bet' thesis during a Portfolio Opportunity Review",
      },
      thirty_year_treasury_pct: dgs30 && {
        ...dgs30,
        signal: dgs30.value > 5.0 ? "ABOVE 5.0% — elevated long-term yields worth watching (crash-check-rules.md's threshold)" : "below the 5.0% elevated-yield watch threshold",
      },
      sofr_pct: sofr && { ...sofr, signal: "repo/dollar-funding stress reference rate — read alongside reverse_repo_usd_billions, no single-direction band" },
      broad_dollar_index: dtwexbgs && { ...dtwexbgs, signal: "rising = dollar strength, tightens global dollar-funding conditions and pressures EM/commodities" },
      nfci_risk_subindex: nfciRisk && { ...nfciRisk, signal: nfciRisk.value > 0 ? "elevated financial-sector volatility/funding risk" : "below-average" },
      nfci_credit_subindex: nfciCredit && { ...nfciCredit, signal: nfciCredit.value > 0 ? "tighter credit conditions specifically" : "looser than average" },
      tips_real_yield_10y_pct: dfii10 && { ...dfii10, signal: "real-yield leg of equity valuation only — no free earnings-yield/CAPE series exists on FRED, do not treat as a full valuation read" },
      recession_probability_smoothed_pct: recessionProbSmoothed && {
        ...recessionProbSmoothed,
        signal: "Chauvet & Piger's published dynamic-factor Markov-switching model (hosted on FRED by the St. Louis Fed, not built by them) — external cross-check, not validation of your own crash-probability estimate",
      },
      recession_probability_ny_fed_12mo_pct: nyFedRecessionProb,
      small_cap_breadth: smallCapBreadth,
      copper_price_usd_per_ton: copper && {
        ...copper,
        signal: "\"Dr. Copper\" -- a classic leading growth/recession-cycle indicator. Informational cross-check for the Type B (Recession) crash-type diagnosis (crash-check-rules.md Stage 1), NOT one of that diagnosis's hard trigger criteria (unemployment/Sahm/CPI, unchanged) and never part of the 6-indicator wave-authorization gate. Monthly cadence (IMF-sourced via FRED) -- a single month's move means little, read the trend.",
      },
      effective_fed_funds_rate_pct: dff && {
        ...dff,
        signal: "the Fed's own overnight rate -- distinct from yield_curve_2s10s/thirty_year_treasury_pct above, which are market-priced Treasury yields, not the Fed's target/effective rate. The anchor everything else in the curve is priced off.",
      },
      federal_debt_pct_gdp: debtToGdp && {
        ...debtToGdp,
        signal: "quarterly, lags -- the structural debt-load backdrop behind a \"fiscal dominance\" read (rate levels/borrowing overriding the usual yield-vs-equity relationship). Level alone isn't a crash signal; watch the trend/rate of change, not a single threshold.",
      },
      gold_price: goldPrice,
      bitcoin_price: bitcoinPrice,
      sector_rotation: {
        tickers: sectorRotation,
        signal:
          "11 Select Sector SPDRs + SPY + GLD, from State Street's own free NAV-history files. " +
          "flow_estimate_usd is a genuine creation/redemption signal (share-count change x NAV, " +
          "price-independent) -- not a price proxy. But it's ETF-VEHICLE-level flow, not a complete " +
          "picture of money entering/leaving the underlying sector -- investors can get the same " +
          "exposure through other ETFs (e.g. QQQ/VGT/SMH instead of XLK). nav_return_pct is price " +
          "only, not total return (dividends excluded). rotation_read classifies each window as " +
          "confirmed_in/confirmed_out (return and flow agree) or accumulation_divergence/" +
          "distribution_divergence (they disagree -- e.g. price falling while real money is still " +
          "arriving) -- report this distinction explicitly rather than just the raw return, since a " +
          "return-only read can't tell genuine rotation from price noise. nav_return_vs_spy_pct is " +
          "return relative to the market -- a positive absolute return can still be substantial " +
          "underperformance (e.g. +2.9% over 180d while SPY did +15%). flow_pct_of_assets expresses " +
          "flow_estimate_usd as a % of assets at the start of that window, so a $1B flow into a $10B " +
          "sector and a $1B flow into a $1T one don't read as equally significant. Informational " +
          "only, Tier 2 -- never part of the 3-of-6 wave-authorization gate.",
      },
      divergence_flags: divergenceFlags,
    });
  }),
);

const WAVE_ORDER: Wave[] = ["WAVE_1", "WAVE_2", "WAVE_3"];

const HARD_RULES = [
  "Never sell existing equity positions on the way down",
  "Never deploy all 3 waves in the same week",
  "Never fire a wave off an unconfirmed threshold breach (confirmed on fewer than 2 distinct ingestion dates)",
  "Never go 100% stable-value mid-crash",
  "Never stop 401k paycheck contributions during a crash",
  "Never touch the passive long-duration account (RRSP-equivalent) during a crash",
  "Never apply wave deployment logic to accounts with no deployment mechanism (e.g. spouse 401k) — monitor only",
];

server.registerTool(
  "get_deployment_plan",
  {
    description:
      "Computes the exact dry-powder deployment breakdown for the tactical 401k, given the current " +
      "wave/authorization status, diagnosed crash type, and which waves are already executed (local " +
      "wave_deployment_state, set only via record_wave_deployment). Deployment is cumulative across " +
      "not-yet-executed waves (see crash-check-rules.md's Wave Deployment section) — read this " +
      "tool's output directly rather than computing dollar amounts by hand. Fund descriptions are " +
      "generic; cross-reference get_portfolio_snapshot for actual fund names, and never persist " +
      "dollar figures via write_snapshot. Call record_wave_deployment only after trades are placed.",
  },
  withLogging("get_deployment_plan", async () => {
    const [latest] = await getRecentCrashChecks(1);
    if (!latest) {
      return json({ error: "No crash_checks rows exist yet — has the rule engine (Stage 3) run?" });
    }

    const waveActive = latest.wave_active as Wave | "NONE" | null;
    const waveActiveReason = latest.wave_active_reason;
    if (!waveActive || waveActive === "NONE") {
      return json({
        wave_active: "NONE",
        message: "No wave currently active — nothing to deploy. Dry powder stays fully in stable value.",
      });
    }

    if (!latest.wave_authorized) {
      return json({
        wave_active: waveActive,
        wave_active_reason: waveActiveReason,
        wave_authorized: false,
        message:
          `${waveActive}'s S&P drawdown/VIX threshold has been observed but is not yet authorized — ` +
          "fewer than 3 of 6 indicators are confirmed RED (see get_indicator_panel's confirmed_red_count). " +
          "No deployment plan until wave_authorized is true.",
      });
    }

    const eligibleIndex = WAVE_ORDER.indexOf(waveActive);
    const deploymentState = readWaveDeploymentState();
    const pendingWaves = WAVE_ORDER.slice(0, eligibleIndex + 1).filter((w) => !deploymentState[w].executed);

    const dryPowderUsd = readDryPowderUsd();

    if (pendingWaves.length === 0) {
      return json({
        wave_active: waveActive,
        wave_active_reason: waveActiveReason,
        wave_authorized: true,
        message: `All waves through ${waveActive} have already been executed (see wave_deployment_state) — nothing new to deploy.`,
        deployment_state: deploymentState,
      });
    }

    const wavePlans = pendingWaves.map((w) => ({ wave: w, ...computeWaveDeployment(w, dryPowderUsd) }));

    const crashType = latest.crash_type as CrashType | null;
    const crashTypeLayer = crashType ? computeCrashTypeLayer(crashType, dryPowderUsd) : null;

    return json({
      wave_active: waveActive,
      wave_active_reason: waveActiveReason,
      wave_authorized: true,
      dry_powder_usd: dryPowderUsd,
      pending_waves: pendingWaves,
      wave_deployment: wavePlans,
      ...(pendingWaves.length > 1
        ? {
            warning:
              `${pendingWaves.length} waves (${pendingWaves.join(", ")}) are pending at once — per the hard rules, ` +
              "never deploy all 3 waves in the same week. Stagger execution and call record_wave_deployment after each.",
          }
        : {}),
      crash_type: crashType,
      crash_type_layer: crashTypeLayer,
      hard_rules: HARD_RULES,
    });
  }),
);

server.registerTool(
  "record_wave_deployment",
  {
    description:
      "Records that a wave's deployment plan was actually executed in the brokerage — persists to " +
      "the local wave_deployment_state file so get_deployment_plan stops re-proposing it. Call this " +
      "only after the user confirms trades were actually placed, never speculatively.",
    inputSchema: {
      wave: z.enum(["WAVE_1", "WAVE_2", "WAVE_3"]),
      executed_date: z.string(),
    },
  },
  withLogging("record_wave_deployment", async (input) => {
    const state = recordWaveDeployment(input.wave, input.executed_date);
    return json({ deployment_state: state });
  }),
);

server.registerTool(
  "write_full_report",
  {
    description:
      "Persists this run's Full Report content (watchlist status, crash-type diagnosis, qualitative " +
      "portfolio snapshot) to full_report_snapshots — never anon-readable, read server-side only by " +
      "the Full Report Cloudflare Pages Function. Watchlist status is recomputed here from live " +
      "prices, not trusted from caller input. Do not include personal dollar figures in " +
      "portfolio_context or crash_type_diagnosis — the write is rejected if one is detected anyway. " +
      "Call alongside write_snapshot once the qualitative synthesis is produced. Omit " +
      "crash_type_diagnosis entirely if no crash type is diagnosed this run — do not pass null.",
    inputSchema: {
      crash_type_diagnosis: z
        .object({
          type: z.string(),
          criteria: z.array(
            z.object({
              name: z.string(),
              status: z.string(),
              detail: z.string(),
            }),
          ),
        })
        .optional(),
      portfolio_context: z.string(),
    },
  },
  withLogging("write_full_report", async (input) => {
    const row = await writeFullReport(input);
    return json({ written: row });
  }),
);

server.registerTool(
  "write_portfolio_review",
  {
    description:
      "Persists this Portfolio Opportunity Review's qualitative synthesis (verdict, summary, macro " +
      "cross-reference, per-ticker thesis re-underwrite, risk radar scores) to " +
      "portfolio_review_snapshots — merged into the Full Report page, never anon-readable, same as " +
      "full_report_snapshots. Portfolio drift is recomputed server-side, not taken from this call. Do " +
      "not include personal dollar figures anywhere here — the write is rejected if one is detected " +
      "anyway. Call at the end of every review run, whether or not the user approved ticker changes " +
      "(that's the separate write_watchlist gate).",
    inputSchema: {
      verdict: z.string(),
      summary: z.string(),
      macro_cross_reference: z.string(),
      tickers: z.array(
        z.object({
          symbol: z.string(),
          thesis_verdict: z.string(),
          proposed_change: z.string().nullable(),
          reasoning: z.string(),
        }),
      ),
      risk_radar: z.object({
        geopolitical: z.number().min(0).max(100),
        policy_fed: z.number().min(0).max(100),
        inflation: z.number().min(0).max(100),
        valuation: z.number().min(0).max(100),
        labor_market: z.number().min(0).max(100),
        earnings: z.number().min(0).max(100),
      }),
    },
  },
  withLogging("write_portfolio_review", async (input) => {
    const row = await writePortfolioReview(input);
    return json({ written: row });
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
