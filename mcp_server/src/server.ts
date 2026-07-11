import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getRecentCrashChecks, writeSnapshot, getLatestDataPoint } from "./lib/supabase.js";
import { readPortfolio, readDryPowderUsd, applyLiveFxRate } from "./lib/portfolio.js";
import { computeDelta } from "./lib/delta.js";
import { computeWaveDeployment, computeCrashTypeLayer, type Wave, type CrashType } from "./lib/waveDeployment.js";

const server = new McpServer({ name: "crash-check", version: "1.0.0" });

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

server.registerTool(
  "get_latest_snapshot",
  {
    description:
      "Returns the most recent crash_checks row (indicator panel, wave status, and — if a chat " +
      "run has happened — crash probability/scenario distribution/notes) plus a delta vs the prior row.",
  },
  async () => {
    const [latest, prior] = await getRecentCrashChecks(2);
    if (!latest) {
      return json({ error: "No crash_checks rows exist yet — has the rule engine (Stage 3) run?" });
    }
    return json({ latest, delta: computeDelta(latest, prior) });
  },
);

server.registerTool(
  "get_indicator_panel",
  {
    description: "Returns just the current 6-indicator RED/AMBER/GREEN panel, RED count, and wave status.",
  },
  async () => {
    const [latest] = await getRecentCrashChecks(1);
    if (!latest) {
      return json({ error: "No crash_checks rows exist yet — has the rule engine (Stage 3) run?" });
    }
    return json({
      run_at: latest.run_at,
      indicators: {
        vix: { value: latest.vix_value, color: latest.vix_color },
        hy_spread_bps: { value: latest.hy_spread_bps, color: latest.hy_spread_color },
        sp_drawdown_pct: { value: latest.sp_drawdown_pct, color: latest.sp_drawdown_color },
        treasury_10y_pct: { value: latest.treasury_10y_pct, color: latest.treasury_10y_color },
        sahm_rule: { value: latest.sahm_rule_value, color: latest.sahm_rule_color },
        fed_pivot_signal: { value: latest.fed_pivot_signal, color: latest.fed_pivot_color },
      },
      red_count: latest.red_count,
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

const transport = new StdioServerTransport();
await server.connect(transport);
