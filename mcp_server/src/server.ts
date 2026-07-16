import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getRecentCrashChecks, getLatestCrashCheckWithProbability, writeSnapshot, writeFullReport, writePortfolioReview, refreshFullReportWatchlist, getLatestDataPoint, syncWatchlistTickers } from "./lib/supabase.js";
import { readPortfolio, readDryPowderUsd, applyLiveFxRate, computePortfolioDrift } from "./lib/portfolio.js";
import { computeDelta } from "./lib/delta.js";
import { computeWaveDeployment, computeCrashTypeLayer, type Wave, type CrashType } from "./lib/waveDeployment.js";
import { readWatchlist, writeWatchlist, computeWatchlistStatus } from "./lib/watchlist.js";
import { computeDataFreshness } from "./lib/freshness.js";

const server = new McpServer({ name: "crash-check", version: "1.0.0" });

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

server.registerTool(
  "get_latest_snapshot",
  {
    description:
      "Returns the most recent crash_checks row (indicator panel, wave status, and — if a chat " +
      "run has happened — crash probability/scenario distribution/notes) plus a delta vs the last " +
      "row that actually had a probability (i.e. the last full report, not just the last row of any " +
      "kind — most rows are bare automated refreshes with a null probability). Only call this after " +
      "you've already committed to this run's probability estimate independently — it's for building " +
      "the delta-log framing, not for forming the estimate itself.",
  },
  async () => {
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
  },
);

server.registerTool(
  "get_indicator_panel",
  {
    description:
      "Returns just the current 6-indicator RED/AMBER/GREEN panel, RED count, confirmed-RED count, and " +
      "wave status. Each of the 5 numeric indicators (all but Fed pivot signal) carries confirmed/" +
      "days_confirmed — per crash-check-rules.md's Signal Tiering rule, a RED reading only counts toward " +
      "wave authorization once confirmed across 2+ distinct ingestion dates, not on its first appearance. " +
      "wave_authorized already reflects confirmed_red_count, not raw red_count — report confirmed_red_count " +
      "as the authorizing number, and red_count/pending indicators as context for what's building. Check " +
      "data_freshness.is_fresh before proceeding — if false, the daily GitHub Action ingestion hasn't run " +
      "yet today (or failed), and this panel is a stale prior-day snapshot; stop and tell the user instead " +
      "of analyzing it as if it were current.",
  },
  async () => {
    const [latest] = await getRecentCrashChecks(1);
    if (!latest) {
      return json({ error: "No crash_checks rows exist yet — has the rule engine (Stage 3) run?" });
    }
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
      data_freshness: computeDataFreshness(latest.run_at),
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
      sp500_level: latest.sp500_level,
      sp500_ath: latest.sp500_ath,
      sp500_ath_date: latest.sp500_ath_date,
    });
  },
);

server.registerTool(
  "get_trigger_status",
  {
    description:
      "Returns the status (fired/approaching/pending) of the personal decision triggers, plus the " +
      "current Warsh Fed classification and whether its hard rules are active.",
  },
  async () => {
    const [latest] = await getRecentCrashChecks(1);
    if (!latest) {
      return json({ error: "No crash_checks rows exist yet — has the rule engine (Stage 3) run?" });
    }
    return json({
      trigger_status: latest.trigger_status,
      warsh_classification: latest.warsh_classification,
      warsh_classification_date: latest.warsh_classification_date,
      warsh_hard_rules_active: latest.warsh_hard_rules_active,
    });
  },
);

server.registerTool(
  "get_portfolio_snapshot",
  {
    description:
      "Returns personal account balances/allocations from the local portfolio file. This data " +
      "never leaves this machine — it is not read from or written to Supabase. The RRSP's CAD->USD " +
      "conversion is computed live from FRED's DEXCAUS series (fetched from Supabase, which holds " +
      "only the macro exchange rate — never the resulting personal dollar figure) rather than " +
      "trusting the file's hardcoded snapshot.",
  },
  async () => {
    const portfolio = readPortfolio();
    const dexcaus = await getLatestDataPoint("DEXCAUS");
    if (!dexcaus) {
      // No live rate available yet (e.g. ingestion hasn't run since this
      // series was added) — fall back to the file's hardcoded snapshot
      // rather than failing the whole tool call.
      return json(portfolio);
    }
    return json(applyLiveFxRate(portfolio, dexcaus.value, dexcaus.observation_date));
  },
);

server.registerTool(
  "get_portfolio_drift",
  {
    description:
      "Compares actual holdings_pct against long_term_target_pct for every account that defines " +
      "both, flagging funds drifted more than 5 percentage points from target (same rebalancing-band " +
      "convention mainstream robo-advisors use). Purely mechanical — no macro judgment. The tactical " +
      "401k's dry-powder fund shows up here too (full visibility) even though its large deviation is " +
      "deliberate, not neglect — a standing flag alongside it explains that, rather than the tool " +
      "hiding the fund entirely. Accounts with a known structural_issue but no formal target (e.g. " +
      "spouse 401k) are surfaced as a standing flag instead. Part of the Portfolio Opportunity Review " +
      "process, layered under the crash-check indicator panel: this answers 'is each account still " +
      "close to its own stated target' independent of the macro regime.",
  },
  async () => json(computePortfolioDrift(readPortfolio())),
);

server.registerTool(
  "get_watchlist_status",
  {
    description:
      "Returns the BrokerageLink stock watchlist with live price vs. Wave 1/2/3 targets and a " +
      "deterministic BUY_ZONE/WATCH/WAIT status per ticker (current price at/below Wave 1 target = " +
      "BUY_ZONE, within 20% above = WATCH, more than 20% above = WAIT — same bands as the original " +
      "watchlist design). Prices come from Supabase (public market data, ingested daily via Alpha " +
      "Vantage); targets/thesis/position sizing come from the local watchlist file. Purely " +
      "mechanical — use this instead of estimating prices via web search.",
  },
  async () => {
    const watchlist = readWatchlist();
    const prices = await Promise.all(watchlist.tickers.map((t) => getLatestDataPoint(t.symbol)));
    return json({
      updated_at: watchlist.updated_at,
      tickers: computeWatchlistStatus(watchlist.tickers, prices),
    });
  },
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
  async (input) => {
    const written = writeWatchlist(input.tickers, `Claude (portfolio review): ${input.change_summary}`);
    await syncWatchlistTickers(input.tickers.map((t) => t.symbol));
    // Keeps the Full Report page's cached watchlist table from going stale
    // relative to this change — otherwise it'd only refresh on the next
    // write_full_report call (during "run crash check"), potentially days
    // later, contradicting whatever a Portfolio Review just wrote about it.
    await refreshFullReportWatchlist(input.tickers);
    return json({ written });
  },
);

server.registerTool(
  "write_snapshot",
  {
    description:
      "Persists this run's qualitative synthesis (crash probability, scenario distribution, " +
      "narrative notes) back to Supabase, combined with the current indicator panel/wave status " +
      "from the latest rule-engine row. Do not include any personal dollar figures in `notes` — " +
      "this is written to Supabase, which holds macro/rule state only.",
    inputSchema: {
      crash_probability_pct: z.number().min(0).max(100),
      crash_probability_low_pct: z.number().min(0).max(100),
      crash_probability_high_pct: z.number().min(0).max(100),
      scenario_bull_pct: z.number().min(0).max(100),
      scenario_base_pct: z.number().min(0).max(100),
      scenario_bear_pct: z.number().min(0).max(100),
      scenario_crash_pct: z.number().min(0).max(100),
      notes: z.string(),
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
  async (input) => {
    const scenarioSum =
      input.scenario_bull_pct + input.scenario_base_pct + input.scenario_bear_pct + input.scenario_crash_pct;
    if (Math.abs(scenarioSum - 100) > 0.5) {
      return json({ error: `Scenario distribution must sum to 100, got ${scenarioSum}` });
    }
    const row = await writeSnapshot(input);
    return json({ written: row });
  },
);

server.registerTool(
  "get_context_indicators",
  {
    description:
      "Returns supplementary macro indicators — financial stress/conditions indices, breakeven " +
      "inflation, bank lending standards, reverse repo, the 2s10s yield curve spread, jobless " +
      "claims, credit card delinquencies, WTI crude oil, and retail sales. These are informational " +
      "context only — NOT part of the 6-indicator wave-authorization gate (that stays exactly " +
      "VIX/HY spread/drawdown/10yr/Sahm/Fed pivot, per the user's own fixed rules). Use these to " +
      "enrich narrative synthesis, never to override or supplement the RED count / wave_authorized decision.",
  },
  async () => {
    const [stlfsi4, nfci, t10yie, drtscilm, rrpontsyd, dgs10, dgs2, icsa, drcclacbs, wti, retailSales] =
      await Promise.all(
        [
          "STLFSI4",
          "NFCI",
          "T10YIE",
          "DRTSCILM",
          "RRPONTSYD",
          "DGS10",
          "DGS2",
          "ICSA",
          "DRCCLACBS",
          "DCOILWTICO",
          "RSAFS",
        ].map(getLatestDataPoint),
      );

    const twoTenSpread =
      dgs10 && dgs2
        ? {
            value_pct: Math.round((dgs10.value - dgs2.value) * 100) / 100,
            as_of: dgs10.observation_date,
            signal: dgs10.value - dgs2.value < 0 ? "INVERTED — historically precedes recessions" : "normal (positive slope)",
          }
        : null;

    return json({
      financial_stress_index: stlfsi4 && { ...stlfsi4, signal: stlfsi4.value > 0 ? "above-average stress" : "below-average stress" },
      national_financial_conditions: nfci && { ...nfci, signal: nfci.value > 0 ? "tighter than average" : "looser than average" },
      breakeven_inflation_10y: t10yie,
      bank_lending_standards_tightening_pct: drtscilm && { ...drtscilm, signal: drtscilm.value > 0 ? "net tightening" : "net easing" },
      reverse_repo_usd_billions: rrpontsyd,
      yield_curve_2s10s: twoTenSpread,
      initial_jobless_claims: icsa,
      credit_card_delinquency_rate_pct: drcclacbs,
      wti_crude_usd_per_barrel: wti && { ...wti, signal: wti.value > 100 ? "above $100 — stagflation accelerant watch" : "below $100" },
      retail_sales_usd_millions: retailSales,
    });
  },
);

server.registerTool(
  "get_deployment_plan",
  {
    description:
      "Computes the exact dollar breakdown for the tactical 401k's dry-powder deployment, given " +
      "the current wave status and crash type (if diagnosed) — combining the live dry_powder_usd " +
      "figure from the local portfolio file with the fixed % splits from crash-check-rules.md. " +
      "This replaces doing that arithmetic yourself: read this tool's output directly rather than " +
      "computing dollar amounts from get_indicator_panel + get_portfolio_snapshot by hand. Fund " +
      "descriptions here are generic (matching the rules doc) — cross-reference " +
      "get_portfolio_snapshot for the actual fund names when reporting to the user; never persist " +
      "dollar figures via write_snapshot.",
  },
  async () => {
    const [latest] = await getRecentCrashChecks(1);
    if (!latest) {
      return json({ error: "No crash_checks rows exist yet — has the rule engine (Stage 3) run?" });
    }

    const waveActive = latest.wave_active as Wave | "NONE" | null;
    if (!waveActive || waveActive === "NONE") {
      return json({
        wave_active: "NONE",
        message: "No wave currently authorized — nothing to deploy. Dry powder stays fully in stable value.",
      });
    }

    const dryPowderUsd = readDryPowderUsd();
    const wavePlan = computeWaveDeployment(waveActive, dryPowderUsd);

    const crashType = latest.crash_type as CrashType | null;
    const crashTypeLayer = crashType ? computeCrashTypeLayer(crashType, dryPowderUsd) : null;

    return json({
      wave_active: waveActive,
      dry_powder_usd: dryPowderUsd,
      wave_deployment: wavePlan,
      crash_type: crashType,
      crash_type_layer: crashTypeLayer,
      hard_rules: [
        "Never sell existing equity positions on the way down",
        "Never deploy all 3 waves in the same week",
        "Never go 100% stable-value mid-crash",
        "Never stop 401k paycheck contributions during a crash",
        "Never touch the passive long-duration account (RRSP-equivalent) during a crash",
      ],
    });
  },
);

server.registerTool(
  "write_full_report",
  {
    description:
      "Persists this run's Full Report content (BrokerageLink watchlist status, crash-type diagnosis, " +
      "and the qualitative-only parts of the personal portfolio snapshot) to full_report_snapshots — " +
      "a table that is never anon-readable, read server-side only by the Full Report Cloudflare Pages " +
      "Function behind Cloudflare Access. Watchlist status is recomputed here from live prices, not " +
      "trusted from caller input. Do not include any personal dollar figures in portfolio_context or " +
      "crash_type_diagnosis — e.g. the RRSP/spouse-401k opportunity-cost gap must stay chat-only, " +
      "never passed to this tool; the write will be rejected if a real portfolio dollar figure is " +
      "detected anyway. Call this alongside write_snapshot in the same run, once the qualitative " +
      "synthesis (crash-type diagnosis, portfolio narrative) has been produced.",
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
        .nullable(),
      portfolio_context: z.string(),
    },
  },
  async (input) => {
    const row = await writeFullReport(input);
    return json({ written: row });
  },
);

server.registerTool(
  "write_portfolio_review",
  {
    description:
      "Persists this Portfolio Opportunity Review's qualitative synthesis (verdict, summary, macro " +
      "cross-reference, per-ticker thesis re-underwrite, risk radar scores) to portfolio_review_snapshots " +
      "— merged into the Full Report page alongside crash-check content. Never anon-readable, same as " +
      "full_report_snapshots. Portfolio drift is recomputed server-side from the local portfolio file, " +
      "not taken from this call. Do not include any personal dollar figures anywhere here (verdict, " +
      "summary, macro_cross_reference, ticker reasoning/proposed_change) — e.g. the RRSP/spouse-401k " +
      "opportunity-cost gap must stay chat-only; the write is rejected if a real portfolio dollar figure " +
      "is detected anyway. Call this at the end of every Portfolio Opportunity Review run, whether or not " +
      "the user approved any ticker changes (that's a separate gate on write_watchlist specifically).",
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
  async (input) => {
    const row = await writePortfolioReview(input);
    return json({ written: row });
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
