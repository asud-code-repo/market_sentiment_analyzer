import { createClient } from "@supabase/supabase-js";
import { readPortfolio, findLeakedDollarFigures, computePortfolioDrift } from "./portfolio.js";
import { readWatchlist, computeWatchlistStatus, type WatchlistTicker } from "./watchlist.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

export const supabase = createClient(
  requireEnv("SUPABASE_URL"),
  requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
);

/** Mirrors rule_engine/src/rules.ts's ConfirmationEntry — separate TS
 * project, so duplicated rather than shared across a package boundary. */
export interface ConfirmationEntry {
  color: "GREEN" | "AMBER" | "RED";
  observation_date: string;
  days_confirmed: number;
  confirmed: boolean;
  first_breach_date: string;
}

// Mirrors the crash_checks columns — see supabase/migrations/20260708000000_stage1_schema.sql
export interface CrashCheckRow {
  id: string;
  run_at: string;
  crash_probability_pct: number | null;
  crash_probability_low_pct: number | null;
  crash_probability_high_pct: number | null;
  scenario_bull_pct: number | null;
  scenario_base_pct: number | null;
  scenario_bear_pct: number | null;
  scenario_crash_pct: number | null;
  sp500_level: number;
  sp500_ath: number;
  sp500_ath_date: string;
  vix_value: number | null;
  vix_color: string | null;
  hy_spread_bps: number | null;
  hy_spread_color: string | null;
  sp_drawdown_pct: number | null;
  sp_drawdown_color: string | null;
  treasury_10y_pct: number | null;
  treasury_10y_color: string | null;
  sahm_rule_value: number | null;
  sahm_rule_color: string | null;
  fed_pivot_signal: string | null;
  fed_pivot_color: string | null;
  red_count: number;
  confirmed_red_count: number | null;
  confirmation_state: Record<string, ConfirmationEntry> | null;
  wave_authorized: boolean;
  wave_active: string | null;
  crash_type: string | null;
  warsh_classification: string | null;
  warsh_classification_date: string | null;
  warsh_hard_rules_active: boolean;
  trigger_status: unknown;
  notes: string | null;
  raw_source_data: unknown;
  created_at: string;
}

export interface DataPointRow {
  series_id: string;
  observation_date: string;
  value: number;
}

/** Most recent row for a series_id, or null if we've never ingested it. */
export async function getLatestDataPoint(seriesId: string): Promise<DataPointRow | null> {
  const { data, error } = await supabase
    .from("data_points")
    .select("series_id, observation_date, value")
    .eq("series_id", seriesId)
    .order("observation_date", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to read latest data_point for ${seriesId}: ${error.message}`);
  }
  return data;
}

/**
 * Full-replacement sync of the watchlist ticker *list* (symbols only) in
 * Supabase — deletes any symbol no longer present, inserts any new one.
 * Keeps ingestion's watchlist_tickers table in step with whatever
 * write_watchlist just wrote locally, in the same call, so there's no
 * separate manual step to remember. Symbols alone aren't personal data —
 * see supabase/migrations/20260711000000_watchlist_tickers.sql.
 */
export async function syncWatchlistTickers(symbols: string[]): Promise<void> {
  const { data: existing, error: readError } = await supabase.from("watchlist_tickers").select("symbol");
  if (readError) {
    throw new Error(`Failed to read watchlist_tickers: ${readError.message}`);
  }

  const existingSymbols = new Set((existing ?? []).map((row) => row.symbol as string));
  const desiredSymbols = new Set(symbols);

  const toInsert = symbols.filter((s) => !existingSymbols.has(s));
  const toDelete = [...existingSymbols].filter((s) => !desiredSymbols.has(s));

  if (toInsert.length > 0) {
    const { error } = await supabase.from("watchlist_tickers").insert(toInsert.map((symbol) => ({ symbol })));
    if (error) throw new Error(`Failed to insert into watchlist_tickers: ${error.message}`);
  }
  if (toDelete.length > 0) {
    const { error } = await supabase.from("watchlist_tickers").delete().in("symbol", toDelete);
    if (error) throw new Error(`Failed to delete from watchlist_tickers: ${error.message}`);
  }
}

/** Most recent rows, newest first. `limit=2` is enough for a delta calc. */
export async function getRecentCrashChecks(limit: number): Promise<CrashCheckRow[]> {
  const { data, error } = await supabase
    .from("crash_checks")
    .select("*")
    .order("run_at", { ascending: false })
    .limit(limit);

  if (error) {
    throw new Error(`Failed to read crash_checks: ${error.message}`);
  }
  return data ?? [];
}

/**
 * The most recent row that actually has a crash_probability_pct — i.e. the
 * last full chat-triggered report, not just the last row of any kind. Most
 * rows are bare automated rule-engine refreshes with a null probability (see
 * classify.ts, which never sets this field), so naively using "the previous
 * row" for a delta comparison frequently diffs against null instead of a
 * real prior estimate. Mirrors the same backward-search dashboard_site's
 * selectIndex() already does client-side for its delta log.
 */
export async function getLatestCrashCheckWithProbability(): Promise<CrashCheckRow | null> {
  const { data, error } = await supabase
    .from("crash_checks")
    .select("*")
    .not("crash_probability_pct", "is", null)
    .order("run_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to read latest crash_checks row with a probability: ${error.message}`);
  }
  return data;
}

/**
 * Inserts a new crash_checks row combining the latest row's mechanical
 * fields (indicator panel, wave status, S&P level/ATH — read fresh here,
 * not trusted from caller input) with the qualitative fields Claude
 * supplies. Throws if no prior row exists — the rule engine (Stage 3) must
 * run at least once before a chat-side write_snapshot call is possible.
 */
export async function writeSnapshot(qualitative: {
  crash_probability_pct: number;
  crash_probability_low_pct: number;
  crash_probability_high_pct: number;
  scenario_bull_pct: number;
  scenario_base_pct: number;
  scenario_bear_pct: number;
  scenario_crash_pct: number;
  notes: string;
  crash_type?: string | null;
  warsh_classification?: string | null;
  warsh_classification_date?: string | null;
  warsh_hard_rules_active?: boolean;
  fed_pivot_signal?: "NONE" | "PAUSE" | "CUT";
  trigger_status?: unknown;
}): Promise<CrashCheckRow> {
  const [latest] = await getRecentCrashChecks(1);
  if (!latest) {
    throw new Error("No prior crash_checks row found — the rule engine (Stage 3) must run at least once first.");
  }

  // Code-level guardrail, not just a prompt instruction: crash_checks is
  // public (anon-readable), so notes must never contain a real personal
  // dollar figure. Checked against local_state/portfolio.yaml directly
  // rather than trusted to the model having followed the "no dollar
  // amounts in notes" instruction correctly.
  const leaked = findLeakedDollarFigures(qualitative.notes, readPortfolio());
  if (leaked.length > 0) {
    throw new Error(
      `Refusing to write: notes appears to contain a real personal dollar figure ` +
        `(${leaked.map((n) => n.toLocaleString("en-US")).join(", ")}). ` +
        `Supabase is macro/market data only — rephrase without the specific figure and try again.`,
    );
  }

  const fedPivotSignal = qualitative.fed_pivot_signal ?? (latest.fed_pivot_signal as "NONE" | "PAUSE" | "CUT" | null) ?? "NONE";
  const fedPivotColor = fedPivotSignal === "NONE" ? "GREEN" : fedPivotSignal === "PAUSE" ? "AMBER" : "RED";

  const row = {
    // Mechanical fields carried forward from the latest rule-engine row —
    // Claude reports on these, it doesn't recompute or override them
    // (except fed_pivot_signal, the one manually-judged indicator).
    sp500_level: latest.sp500_level,
    sp500_ath: latest.sp500_ath,
    sp500_ath_date: latest.sp500_ath_date,
    vix_value: latest.vix_value,
    vix_color: latest.vix_color,
    hy_spread_bps: latest.hy_spread_bps,
    hy_spread_color: latest.hy_spread_color,
    sp_drawdown_pct: latest.sp_drawdown_pct,
    sp_drawdown_color: latest.sp_drawdown_color,
    treasury_10y_pct: latest.treasury_10y_pct,
    treasury_10y_color: latest.treasury_10y_color,
    sahm_rule_value: latest.sahm_rule_value,
    sahm_rule_color: latest.sahm_rule_color,
    fed_pivot_signal: fedPivotSignal,
    fed_pivot_color: fedPivotColor,
    red_count: latest.red_count,
    // Carried forward, not recomputed — confirmation_state is rule-engine-
    // owned (classify.ts's per-indicator streak tracking). If write_snapshot
    // didn't propagate it, the next classify() run would see a null prior
    // confirmation_state and incorrectly reset every indicator's streak.
    confirmed_red_count: latest.confirmed_red_count,
    confirmation_state: latest.confirmation_state,
    wave_authorized: latest.wave_authorized,
    wave_active: latest.wave_active,

    // Qualitative fields from Claude's synthesis this run.
    crash_probability_pct: qualitative.crash_probability_pct,
    crash_probability_low_pct: qualitative.crash_probability_low_pct,
    crash_probability_high_pct: qualitative.crash_probability_high_pct,
    scenario_bull_pct: qualitative.scenario_bull_pct,
    scenario_base_pct: qualitative.scenario_base_pct,
    scenario_bear_pct: qualitative.scenario_bear_pct,
    scenario_crash_pct: qualitative.scenario_crash_pct,
    notes: qualitative.notes,
    crash_type: qualitative.crash_type ?? latest.crash_type,
    warsh_classification: qualitative.warsh_classification ?? latest.warsh_classification,
    warsh_classification_date: qualitative.warsh_classification_date ?? latest.warsh_classification_date,
    warsh_hard_rules_active: qualitative.warsh_hard_rules_active ?? latest.warsh_hard_rules_active,
    trigger_status: qualitative.trigger_status ?? latest.trigger_status,
    raw_source_data: { copied_from_crash_check_id: latest.id },
  };

  const { data, error } = await supabase.from("crash_checks").insert(row).select().single();
  if (error) {
    throw new Error(`Failed to insert crash_checks row: ${error.message}`);
  }
  return data;
}

export interface FullReportCriterion {
  name: string;
  status: string;
  detail: string;
}

export interface FullReportCrashTypeDiagnosis {
  type: string;
  criteria: FullReportCriterion[];
}

export interface FullReportSnapshotRow {
  id: string;
  run_at: string;
  watchlist: unknown;
  crash_type_diagnosis: FullReportCrashTypeDiagnosis | null;
  portfolio_context: string | null;
  source_crash_check_id: string | null;
  created_at: string;
}

/**
 * Inserts a new full_report_snapshots row — the second write path covered by
 * the dollar-figure guardrail (see [[backlog_write_snapshot_dollar_figure_guardrail]]
 * in project memory / BACKLOG.md's "Security & access" section). Watchlist
 * status is recomputed here from live prices, exactly like get_watchlist_status,
 * rather than trusted from caller input — same "rule engine output contract"
 * discipline as writeSnapshot's mechanical fields. max_position_usd is
 * stripped even though this table is already access-gated (never anon-
 * readable) — belt-and-suspenders, consistent with treating personal dollar
 * figures as never-persist rather than persist-but-restrict.
 */
export async function writeFullReport(qualitative: {
  crash_type_diagnosis: FullReportCrashTypeDiagnosis | null;
  portfolio_context: string;
}): Promise<FullReportSnapshotRow> {
  const [latest] = await getRecentCrashChecks(1);
  if (!latest) {
    throw new Error("No prior crash_checks row found — the rule engine (Stage 3) must run at least once first.");
  }

  const diagnosisText = qualitative.crash_type_diagnosis
    ? qualitative.crash_type_diagnosis.criteria.map((c) => c.detail).join(" ")
    : "";
  const leaked = findLeakedDollarFigures(`${qualitative.portfolio_context} ${diagnosisText}`, readPortfolio());
  if (leaked.length > 0) {
    throw new Error(
      `Refusing to write: portfolio_context/crash_type_diagnosis appears to contain a real personal dollar figure ` +
        `(${leaked.map((n) => n.toLocaleString("en-US")).join(", ")}). ` +
        `full_report_snapshots is qualitative-only — rephrase without the specific figure and try again.`,
    );
  }

  const watchlistFile = readWatchlist();
  const prices = await Promise.all(watchlistFile.tickers.map((t) => getLatestDataPoint(t.symbol)));
  const watchlist = computeWatchlistStatus(watchlistFile.tickers, prices).map(
    ({ max_position_usd: _maxPositionUsd, ...rest }) => rest,
  );

  const row = {
    watchlist,
    crash_type_diagnosis: qualitative.crash_type_diagnosis,
    portfolio_context: qualitative.portfolio_context,
    source_crash_check_id: latest.id,
  };

  const { data, error } = await supabase.from("full_report_snapshots").insert(row).select().single();
  if (error) {
    throw new Error(`Failed to insert full_report_snapshots row: ${error.message}`);
  }
  return data;
}

/**
 * Patches the latest full_report_snapshots row's `watchlist` column with a
 * freshly recomputed status array (same computation writeFullReport uses).
 * Exists because that row otherwise only refreshes when write_full_report
 * runs (during "run crash check") — a target change from write_watchlist
 * during a separate, later Portfolio Review would otherwise sit stale on
 * the Full Report page until the next crash check, silently contradicting
 * the Portfolio Review section's own narrative about the very same change
 * (observed live 2026-07-16: CCJ's updated $70 target wasn't reflected in
 * the watchlist table for two days). No-ops if no full_report_snapshots
 * row exists yet — nothing to patch, and write_full_report will create the
 * first one whenever the next crash check runs.
 */
async function getRecentFullReportSnapshots(limit: number): Promise<{ id: string }[]> {
  const { data, error } = await supabase
    .from("full_report_snapshots")
    .select("id")
    .order("run_at", { ascending: false })
    .limit(limit);

  if (error) {
    throw new Error(`Failed to read full_report_snapshots: ${error.message}`);
  }
  return data ?? [];
}

export async function refreshFullReportWatchlist(tickers: WatchlistTicker[]): Promise<void> {
  const [latest] = await getRecentFullReportSnapshots(1);
  if (!latest) return;

  const prices = await Promise.all(tickers.map((t) => getLatestDataPoint(t.symbol)));
  const watchlist = computeWatchlistStatus(tickers, prices).map(
    ({ max_position_usd: _maxPositionUsd, ...rest }) => rest,
  );

  const { error } = await supabase.from("full_report_snapshots").update({ watchlist }).eq("id", latest.id);
  if (error) {
    throw new Error(`Failed to refresh full_report_snapshots.watchlist: ${error.message}`);
  }
}

export interface PortfolioReviewTickerEntry {
  symbol: string;
  thesis_verdict: string;
  proposed_change: string | null;
  reasoning: string;
}

export interface RiskRadarScores {
  geopolitical: number;
  policy_fed: number;
  inflation: number;
  valuation: number;
  labor_market: number;
  earnings: number;
}

export interface PortfolioReviewSnapshotRow {
  id: string;
  run_at: string;
  verdict: string | null;
  summary: string | null;
  macro_cross_reference: string | null;
  drift: unknown;
  tickers: PortfolioReviewTickerEntry[];
  risk_radar: RiskRadarScores | null;
  source_crash_check_id: string | null;
  created_at: string;
}

/**
 * Inserts a new portfolio_review_snapshots row — merges Portfolio
 * Opportunity Review content into the Full Report page (see
 * backlog_unify_crash_check_dashboard_site in project memory/BACKLOG.md;
 * this reverses the earlier "chat-only, never published" decision on
 * portfolio-review-template.html per explicit 2026-07-16 instruction).
 * Drift is recomputed server-side from computePortfolioDrift(), not
 * trusted from the caller, same discipline as writeFullReport's watchlist
 * recomputation. Guardrail-checked the same way as the other two write
 * paths — every free-text field (verdict/summary/macro_cross_reference/
 * per-ticker reasoning+proposed_change, plus drift's standing_flags) is
 * scanned for real portfolio dollar figures before writing.
 */
export async function writePortfolioReview(qualitative: {
  verdict: string;
  summary: string;
  macro_cross_reference: string;
  tickers: PortfolioReviewTickerEntry[];
  risk_radar: RiskRadarScores;
}): Promise<PortfolioReviewSnapshotRow> {
  const [latestCrashCheck] = await getRecentCrashChecks(1);

  const portfolio = readPortfolio();
  const drift = computePortfolioDrift(portfolio);

  const combinedText = [
    qualitative.verdict,
    qualitative.summary,
    qualitative.macro_cross_reference,
    ...qualitative.tickers.map((t) => `${t.reasoning} ${t.proposed_change ?? ""}`),
    ...drift.standing_flags,
  ].join(" ");

  const leaked = findLeakedDollarFigures(combinedText, portfolio);
  if (leaked.length > 0) {
    throw new Error(
      `Refusing to write: portfolio review content appears to contain a real personal dollar figure ` +
        `(${leaked.map((n) => n.toLocaleString("en-US")).join(", ")}). ` +
        `portfolio_review_snapshots is qualitative-only — rephrase without the specific figure and try again.`,
    );
  }

  const row = {
    verdict: qualitative.verdict,
    summary: qualitative.summary,
    macro_cross_reference: qualitative.macro_cross_reference,
    drift,
    tickers: qualitative.tickers,
    risk_radar: qualitative.risk_radar,
    source_crash_check_id: latestCrashCheck?.id ?? null,
  };

  const { data, error } = await supabase.from("portfolio_review_snapshots").insert(row).select().single();
  if (error) {
    throw new Error(`Failed to insert portfolio_review_snapshots row: ${error.message}`);
  }
  return data;
}
