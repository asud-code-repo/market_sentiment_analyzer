# Independent review — Market Sentiment Analyzer

Review date: 2026-09-19. Scope: shared master instructions and Prompts 2, 4, 3, and 7, in that order. Objective: improve market-stress forecast validity and practical usefulness. This is a read-only assessment, not authorization to implement or trade.

## Executive assessment

The system is a useful **stress-monitoring and discretionary decision-support foundation**, but the supplied evidence does not establish reliable crash probabilities or improved investment outcomes. Its strongest design choice is keeping mechanical indicators, the statistical score, and LLM commentary in separate fields. Its principal weakness is that the statistical research cannot be reproduced from this snapshot, while the UI describes the model as validated and calibrated.

The most consequential confirmed errors are scoring a conditional forecast outside its stated population, counting a recovery flag in deployment authorization, and discarding a trough before evaluating recovery. Point-in-time data and freshness controls also fall short of the claims readers could infer.

**Confidence:** high in the cited implementation findings and synthetic reproductions; limited in statistical performance and economic usefulness because training data, labels, folds, forecasts, and portfolio results were not supplied. No accuracy improvement is demonstrated or claimed. Correctness fixes should precede model expansion.

## Five most important improvements

These are five workstreams, not five assertions of proven predictive uplift. The deployment-count defect warrants immediate containment even while statistical validation remains the main research priority.

| Rank | Improvement | Findings | Validation needed | Priority |
|---|---|---|---|---|
| 1 | Define and enforce the forecast target and eligible population; distinguish an existing correction from a future breach | F01, F08 | Boundary and episode-path fixtures; independently audited labels, including new peaks and incomplete horizons | High |
| 2 | Establish point-in-time inputs, a coherent forecast timestamp, and source-level freshness | F02, F06, F07 | Release/vintage replay; stale-source, quarantine, missing-session, and same-date-revision injection | High |
| 3 | Reproduce training and test the entire model-plus-calibrator against simple baselines | F03, F04, F13 | Chronological, purged evaluation with dependence-aware uncertainty; drawdown-only and volatility/trend ablations | High |
| 4 | Correct deployment/recovery state and alert semantics before evaluating portfolio policies | F05, F07, F08, F14 | Cross-writer invariants, recovery lifecycle tests, then a cost-aware policy experiment | Critical for F05; high for state corrections |
| 5 | Make report claims and LLM output match the available evidence | F09–F12, F01, F03 | Grounding and adversarial replay; report comprehension tests; explicit experimental status and provenance | High |

The implementation handoff is `improvement-backlog.md`. All proposals there remain unimplemented.

## Source identity, method, and independence

- Snapshot: `market_sentiment_analyzer-main(2).zip`; extracted root: `market_sentiment_analyzer-main/`.
- ZIP SHA-256: `ffa33233b7bf75d1f10ab14d0f94143497ae03e061bd60aeaf192c94f8a8d4f3`.
- No `.git` directory or authoritative commit identity is present. The digest identifies the reviewed bytes; it is not a commit SHA. All paths and line numbers below refer to this snapshot.
- Read: README, hazard explanation, master prompt pack, architecture current-state sections, applicable rules and project instructions. Inspected relevant TypeScript, public rendering code, report template, schema/migrations, workflow, and package manifests. This is a targeted review, not a complete security or code audit.
- Independence: did not use `reference_docs/investment-model-review.md`, `BACKLOG.md`, or the architecture document's dedicated prior-review sections as findings evidence. Required documentation and code comments themselves contain historical-review conclusions; these were encountered, but treated as claims to verify, not authority. The defects below were traced to implementation and, where indicated, reproduced independently.
- Executed isolated synthetic checks using Node v24.19.0, stripping TypeScript types and replacing imported I/O with in-memory stubs. Executed the actual extracted `classify`, `writeSnapshot`, scoring, confirmation, and freshness logic. No source files in the repository were edited; no live database writes, ingestion, trades, paid APIs, or deployment occurred. This is not a full application integration test or backtest.
- The [public report](https://market-sentiment.abhaysudhakaran.com/) could not be retrieved through the web reader. Findings about presentation concern `dashboard_site/index.html` and templates, not verified current deployed content. No current report JSON, rendered export, or production database extract was supplied.

**Evidence labels:** **Verified implementation** = directly traced code; **Reproduced defect** = verified with synthetic execution; **Documented, unverified** = repository assertion lacking underlying evidence; **Hypothesis** = a question for empirical testing; **Proposed change** = future work. A missing artifact in this ZIP does not prove it never existed elsewhere.

## Understanding of the current solution

### Implemented flow and decision boundaries

Weekday GitHub Actions run ingestion and then classification. FRED supplies most numerical inputs; EIA, market-price sources, and State Street ETF data provide additional context. Supabase stores observations and report snapshots. A local MCP server reads market state and local portfolio files, supplies tools to Claude Desktop, and persists qualitative reports. The public dashboard reads macro records; the private report uses a server-side function. The scheduled Claude Desktop task is documented rather than represented by an executable scheduler configuration in this ZIP.

`rule_engine/src/rules.ts` maps VIX, HY spreads, S&P drawdown, ten-year yield, Sahm, and a Fed-pivot category into colors. Five numeric indicators receive confirmation counters. The Fed category is human/LLM supplied and counts immediately when `CUT`; a deterministic color mapping does not make that input independent of judgment. Three confirmed RED indicators authorize deployment in principle; drawdown/VIX combinations select Waves 1–3. The model is not a gate. Push notification begins at two confirmed RED indicators, a different threshold.

`hazardModel.ts` is a **fixed-horizon logistic classifier with a calibration mapping**, not an implemented survival process. It standardizes 32 features with frozen means/scales, applies frozen coefficients and an intercept, then linearly interpolates an 18-knot isotonic table. Features comprise drawdown, credit, volatility, rates, labor/macro levels, and 5/20-observation trading-session deltas. Runtime fitting does not occur. LOW is below 35% calibrated, TRANSITIONING is 35% to below 90%, HIGH is at least 90%.

Claude provides a separate crash percentage, range, scenario distribution, risk radar, and narrative. Bounds and scenario totals are partially validated; their economic meaning and empirical reliability are not established by these checks. The tools preserve most mechanical fields but recompute Fed-dependent aggregate counts. The workflow exposes the hazard result before Claude commits its own percentage.

Portfolio functionality exists: local balances, drift, watchlist targets, cumulative wave plans, executed-wave tracking, crash-type sleeves, and recovery detection. This supports an intended use of discretionary deployment of existing dry powder during stress. It does not establish a complete hedging, exit, or re-entry investment strategy.

Sources: `README.md` (Architecture, Layers, workflows); `.github/workflows/ingest.yml`; `rule_engine/src/classify.ts`; `rule_engine/src/rules.ts`; `mcp_server/src/server.ts` (`get_indicator_panel`, `write_snapshot`, `get_deployment_plan`); `mcp_server/src/lib/waveDeployment.ts`; `reference_docs/rules/project-instructions.md`.

### Strengths to preserve

- Mechanical calculations are largely outside the LLM; wave-plan arithmetic and most persisted numerical fields are server-owned.
- Hazard, LLM percentage, and gating indicators are separate; no implemented numeric blend was found.
- Hazard exceptions become unavailable values rather than zero-risk readings.
- Repeated identical observation dates do not increment confirmation counts; daily alerts use threshold crossings rather than unconditional repetition.
- The public code distinguishes observed wave triggers from authorization, labels LLM estimates discretionary, and labels ETF flows as vehicle-level rather than complete sector capital flows.
- Existing modular TypeScript components and frozen scoring arithmetic are small enough to audit. A new distributed architecture is not needed to address these issues.

These are design strengths, not evidence of forecasting skill. Confirmation, provenance, and authorization still have the defects described below.

### Consequential missing evidence

| Evidence needed | Why it changes the verdict |
|---|---|
| Original training script/notebook, `hazard_model_10pct_artifact.json`, environment, full precision export, seed and regularization/class-weight settings | Required to reproduce weights, scaler, table and research/production parity |
| Exact labels, historical price source, peak convention, eligible-day and episode definitions, sample weights and exclusions | Determines what the probability actually means and whether calm periods were represented |
| Dated train/calibration/test membership, matured label cutoffs, predictions, outcomes, baseline scores and bootstrap draws | Required to verify claims of walk-forward skill; distinguishes future-trained leave-one-crisis-out tests from prospective evaluation |
| First-available macro releases/vintages and acquisition times, historical feature vectors | Determines leakage and whether past forecasts could have been made at the claimed time |
| Contemporaneously archived live reports, model/prompt IDs and source citations | Required to evaluate drift, factual grounding and actual reader-facing behavior |
| Historical deployment decisions, constraints, execution costs, cash returns and investable total-return series | Required to establish portfolio value rather than prediction quality alone |
| Current mandate: monitoring versus deployment/hedging, acceptable cash drag, horizon, benchmarks and constraints | Changes the appropriate economic success criterion; example YAML is not a verified current mandate |

No training, label, out-of-sample prediction or outcome dataset, or automated test suite was located in the supplied file inventory. Package scripts expose execution and typechecking, not an evaluation harness.

## Findings register

### F01 — The conditional forecast is scored outside its stated risk set

**Status:** Reproduced defect; exact training estimand remains unverified. **Priority:** High.

Documentation defines a future 10% ATH drawdown breach conditional on not already being there. `classify()` calls feature gathering and scoring without testing that condition; `computeHazardProbability()` also has no eligibility control. The public model card omits the conditioning clause. Synthetic execution at 16% current drawdown still invoked scoring and persisted HIGH. The mock feature vector used the actual negative drawdown and training means for other features; this tests control flow, not a real market forecast.

Sources: `rule_engine/src/classify.ts:97–109`; `rule_engine/src/hazardModel.ts:119–135`; `reference_docs/rules/crash-check-rules.md:675–685`; `dashboard_site/index.html:1018–1038`.

**Consequence:** an estimate intended for an eligible pre-breach population is presented during an existing correction. It cannot establish further-loss probability. Even at 9% drawdown, reaching 10% below the same peak requires only about another 1.10% price decline, not a new 10% loss.

**Proposed:** explicit `eligible`, `already_breached`, `unavailable`, and `experimental` status dimensions; suppress the conditional probability when ineligible. Recover the original label definition before retraining. Do not replace the ineligible result with 100%, which would silently change the question.

### F02 — Current storage and feature retrieval do not support a point-in-time research replay

**Status:** Verified implementation limitation; historical training leakage is documented, not independently reconstructed. **Priority:** High.

FRED requests do not specify historical real-time periods; rows are upserted on `(series_id, observation_date)`, replacing earlier versions. Historical feature queries use observation dates, not when information became available. Current feature levels are fetched independently as latest values, while lags and realized volatility are anchored to the S&P date. This does not prove live look-ahead, but it leaves the declared as-of time inconsistent with a strictly historical information set. Runtime output retains the six core observations and raw score, not the complete 32-feature vector and model artifact identity.

Sources: `ingestion/src/sources/fred.ts:169–189`, `fetchFredHistory`; `ingestion/src/lib/supabase.ts:32–49`; `supabase/migrations/20260708000000_stage1_schema.sql:103–115`; `rule_engine/src/hazardModel.ts:173–180,266–315`; `rule_engine/src/lib/seriesDelta.ts:19–32`; `rule_engine/src/classify.ts:195–201` (`raw_source_data`).

The model includes `RECPROUSM156N` at `hazardModel.ts:58,329`. Its producer confirms smoothed historical values can incorporate later information. The original training data are missing, so the magnitude and precise route of contamination cannot be verified. Independently confirmed source behavior supports taking the repository's warning seriously. It does **not** make the latest released value intrinsically unusable for a live forecast. [Producer FAQ](https://jeremypiger.com/recession_probs_faq/). FRED distinguishes today's knowledge of history from historical vintages. [FRED real-time periods](https://fred.stlouisfed.org/docs/api/fred/realtime_period.html).

**Proposed:** release-time/vintage-aware research data, immutable forecast feature snapshots and explicit forecast issuance time. Audit every macro series, not just recession probability. Retrain jointly when removing/replacing a feature; do not hand-zero coefficients. Audit SP500 and historical running peaks: the backfill writes price history but not every historical ATH. FRED's supplied SP500 is a price index with ten years of daily history, insufficient by itself to reproduce research from 1993. [FRED SP500 notes](https://fred.stlouisfed.org/series/SP500/index.html).

### F03 — Claimed statistical validation cannot be audited from the supplied evidence

**Status:** Documented, unverified; evidence gap, not proof that the model has no skill. **Priority:** High.

The model header and rules claim expanding-window validation, leave-one-crisis-out testing, stratified five-fold calibration on pooled out-of-sample predictions, and bootstrap-confirmed skill. The underlying predictions, folds, training code and statistics are not supplied. Ordinary leave-one-crisis-out can train on later crises; that is a robustness diagnostic, not chronological forecasting. Stratification does not by itself separate overlapping 21-session outcomes. Selecting periods around five severe crises could distort the deployment base rate if calm days and all smaller 10% events were omitted; whether that occurred is unknown.

Sources: `rule_engine/src/hazardModel.ts:1–15`; `reference_docs/rules/crash-check-rules.md:688–703`; `reference_docs/hazard-model-explained.md`, training/calibration sections; supplied repository inventory.

**Proposed:** reproduce the full pipeline, disclose all eligible days and distinct events, and evaluate training, calibration, tuning and threshold selection entirely before each test block. An OOS base-model score is not automatically OOS for a calibrator fitted on its outcome. Explicitly report whether any proposed final holdout has already influenced prior development.

### F04 — The calibration table strongly magnifies small score changes; empirical reliability is unknown

**Status:** Verified arithmetic; instability and miscalibration are research hypotheses. **Priority:** High.

Synthetic calls to the actual interpolation produce: raw 10% → 23.66%; 20% → 66.67%; 20.58% → 66.67%; 20.59% → 80%; 30% and 80% → 92.7%; 90% → 100%. The table also contains repeated zero breakpoints. These facts do not prove the mapping is wrong, but make full-precision export, sample support, population weighting, and stability tests essential. A LOW band can correspond to roughly 24%; its name does not establish low absolute risk. Bands reduce apparent precision but cannot validate probabilities.

Sources: `rule_engine/src/hazardModel.ts:47–166`; `dashboard_site/index.html:1028–1038`.

**Proposed:** compare no calibration, temporally fitted sigmoid calibration and isotonic calibration; inspect reliability with eligible-day counts and independent episode support in each region. Audit artifact precision and duplicated knots without manually editing the table. Report score sensitivity and observed uncertainty. Official guidance explains independent calibration fitting and reliability diagrams; lower Brier loss alone is not proof of improved calibration. [scikit-learn calibration](https://scikit-learn.org/stable/modules/calibration.html).

### F05 — Snapshot persistence can authorize deployment by counting a seventh indicator

**Status:** Reproduced defect. **Priority:** Critical within this decision-support system; live incidence unknown.

`classify()` counts the five core numeric entries before adding `vix_recovery` to `confirmation_state`. `writeSnapshot()` later counts **all** confirmed RED entries in the stored object. Recovery RED means VIX at least 25, with a 15-observation counter; it is not a sixth numeric gating indicator.

Synthetic case: VIX 30 (AMBER), HY RED, Fed CUT (RED), other core indicators non-RED, and recovery RED confirmed. Two legitimate confirmed REDs become three during snapshot persistence; authorization changes false → true. With 16% drawdown, Wave 1 is active, so the deployment-plan path can be enabled. No trade is executed by these functions.

Sources: `rule_engine/src/classify.ts:73–84,132–139`; `rule_engine/src/rules.ts:87–88`; `mcp_server/src/lib/supabase.ts:356–360`; `mcp_server/src/server.ts:600–621`.

**Proposed:** one shared, allowlisted gate computation; recovery state must never enter it. Test rule-engine and snapshot-writer equivalence, including unchanged Fed state. Inspect affected historical records before deciding whether any report correction is necessary; do not silently rewrite archived history.

### F06 — Fresh report timestamps can conceal stale inputs

**Status:** Verified implementation defect in the freshness guarantee; frequency in production unknown. **Priority:** High.

`computeDataFreshness()` inspects the latest crash-check `run_at`, not core observations or the source rule-engine run. The writer inserts a new row while copying mechanical fields. A new narrative can therefore give old data a new timestamp. Required-source success also does not require every core value to survive quarantine; classification accepts any existing latest row. Model input lookup checks presence, not age.

Sources: `mcp_server/src/lib/freshness.ts`, `computeDataFreshness`; `mcp_server/src/server.ts:87–89`; `mcp_server/src/lib/supabase.ts:362–435`; `ingestion/src/ingest.ts`, quarantine and failure handling; `rule_engine/src/classify.ts`, `requireLatest`; `rule_engine/src/hazardModel.ts`, `requireLevel`.

**Proposed:** distinguish generated time, data issuance/cutoff, source observation/release dates, and last successful validated ingestion. Check freshness server-side before authorizing or persisting decision-ready state, using each series' cadence. Monthly data should not fail a daily-age rule. A stale or quarantined core input should result in a visible degraded state, not a silently refreshed plan.

### F07 — Confirmation mishandles revisions and does not prove uninterrupted persistence

**Status:** Same-date behavior reproduced; gap handling verified; monthly latency is a documented design trade-off. **Priority:** High for correctness.

For an unchanged observation date, `computeConfirmation()` returns the old object even if the new color differs. A synthetic confirmed RED followed by revised GREEN on the same date remained confirmed RED. Different dates with the same color increment regardless of intervening missing sessions; two recorded dates do not prove every intervening session held the condition. Sahm requires two monthly observations, not two daily ingestion runs.

Sources: `rule_engine/src/rules.ts:96–145`; `rule_engine/src/classify.ts:73–78`; `rule_engine/src/lib/seriesDelta.ts:89–119` (row-count calendar assumption).

**Proposed:** handle a revised color without pretending it is an additional independent observation; specify out-of-order and missing-session behavior. Name counts “distinct observations,” expose cadence, and backfill/validate required session continuity before calling a condition sustained. Do not simply weaken monthly confirmation without testing its decision impact.

### F08 — Recovery evaluation discards the trough too soon

**Status:** Reproduced defect relative to the stated rebound criterion. **Priority:** High.

At drawdown below 10%, the trough is nulled before testing a 15% rebound. With peak 100, prior trough 80 and current 93, the rebound is 16.25%. Even with Fed CUT and 15 qualifying VIX observations, recovery remains false because the trough was cleared. Crossing below and back above 10% also creates a new episode under the current reset logic, potentially fragmenting a broader decline.

Sources: `rule_engine/src/classify.ts:118–161`; `rule_engine/src/rules.ts:91–94`; `reference_docs/rules/crash-check-rules.md`, Stage 4.

**Proposed:** define an explicit episode lifecycle, retain trough through recovery evaluation, and separate “currently below the drawdown threshold” from “prior episode still being monitored.” Agree reset criteria before changing behavior. The Fed CUT criterion also lacks an independently enforced recency limit.

### F09 — LLM percentages have no testable forecast contract but dominate the report

**Status:** Verified implementation and documented absence of a defined horizon; interpretive risk, not a measured user-study result. **Priority:** High.

The writer requires probability, low/high range and scenarios. It checks individual bounds and scenario sum, but not `low <= point <= high`. No target/horizon or statistical meaning for the range is enforced. The public view gives this percentage the large hero meter and historical chart; it does include a discretionary caveat. Hazard text asserts validation without surfacing the known research limitation at the point of use. Risk radar 0–100 scores similarly are not event probabilities.

Sources: `mcp_server/src/server.ts:300–348`; `dashboard_site/index.html:1137–1174,1028–1038`; `README.md`, introductory limitations; `reference_docs/rules/project-instructions.md`, steps 7–9.

**Proposed:** replace the LLM percentage as headline with a qualitative, evidence-linked stress assessment. Preserve old numbers as clearly labeled historical subjective judgments. If retained experimentally, require a precise event/horizon and range semantics, and collect prospective forecasts before evaluating calibration. Do not implement the draft points-to-percent formula as a validated probability.

### F10 — Grounding and model provenance are largely prompt conventions

**Status:** Verified schema/logging limitations; actual hallucination and injection rates unknown. **Priority:** High.

Narrative writes accept strings without structured claim-to-source records, archived excerpts, model IDs, prompt hashes, or a numerical consistency contract. The token logger records time, tool name and approximate sizes, not a replayable transcript. Anti-anchoring commitment is an instruction to commit in working reasoning, not a persisted or enforced phase boundary. Free-text source content is researched by Claude; this snapshot cannot establish the surrounding client's injection defenses or model/temperature settings. Some tool prose itself provides causal interpretations that should not be treated as measured facts.

Sources: `mcp_server/src/server.ts:274–350,677–745`; `mcp_server/src/lib/tokenLog.ts:24–35`; `mcp_server/src/lib/supabase.ts`, qualitative persistence; `reference_docs/rules/project-instructions.md`, steps 6–12.

**Proposed:** immutable evidence IDs for numerical inputs; structured sourced claims and separately labeled interpretations; prompt/model/run metadata; an enforceable draft-before-prior workflow where independence matters. Validate claims and numerical references outside the model. See the evaluation specification below.

### F11 — Statistical/LLM separation does not establish independence

**Status:** Verified exposure path; degree of anchoring is a hypothesis. **Priority:** Medium.

`get_indicator_panel` supplies raw and calibrated hazard values before step 7's LLM estimate. Both channels also consume overlapping market indicators. The rule text says the hazard is not an input to synthesis, but the actual information is visible. Showing agreement cannot establish independent corroboration; disagreement may reflect different targets or horizons.

Sources: `mcp_server/src/server.ts:106–116`; `reference_docs/rules/project-instructions.md`, steps 1 and 7; `reference_docs/rules/crash-check-rules.md:769–777`.

**Proposed:** either identify the narrative as informed by the statistical output, or withhold model/prior outputs until a separately recorded qualitative draft exists. Compare hazard-visible versus hazard-hidden runs on identical evidence. Do not blend percentages.

### F12 — Historical browsing is incomplete and can eventually misidentify “latest”

**Status:** Verified implementation; 1,000-row failure conditional on dataset size. **Priority:** Medium, high once the limit is reached.

The report query requests the first 1,000 rows in ascending time order and selects the last returned row. It uses the single-page fetch, despite a paginated helper elsewhere. Beyond 1,000 rows, “Jump to latest” points to an older row. Context cards intentionally show current values even when viewing a historical report, and explicitly disclose that separation; however, their query omits observation dates. They cannot support a coherent historical replay or source-age inspection.

Sources: `dashboard_site/index.html:335–362,290–300,1450–1486,1679`.

**Proposed:** reliable latest-row query plus paginated history; per-series dates; strong separate live-context labeling or a true archived as-of view. Also show hazard status/outcomes over time, rather than only LLM probability history. Do not infer that the live site already exceeds the row limit.

### F13 — Monitoring usefulness is plausible; investment benefit remains untested

**Status:** Verified policy machinery; economic effectiveness unknown. **Priority:** High before using policy outputs as evidence-based allocation guidance.

Wave thresholds, percentages and crash-type sleeves are deterministic encodings of a discretionary policy. A probability of crossing 10% below a peak provides neither expected forward return nor severity, recovery timing, optimal cash share, or hedge payoff. The current system buys during stress; a high forecast could therefore support a different decision from a hedging strategy. No supplied evidence resolves that distinction.

Sources: `rule_engine/src/rules.ts:49–73`; `mcp_server/src/server.ts:572–655`; `mcp_server/src/lib/waveDeployment.ts`, `WAVE_DEPLOYMENT` and `CRASH_TYPE_LAYERS`; `mcp_server/src/lib/waveDeploymentState.ts`.

**Proposed:** evaluate one frozen deployment policy with cash carry, delayed execution, costs, rebound participation and a re-entry/episode lifecycle. Wave-spacing restrictions are returned as warnings, not enforced scheduling; original versus remaining dry-powder basis needs an explicit policy contract. Do not optimize a portfolio policy from the 10% breach probability alone.

### F14 — The two-RED notification incorrectly says authorization was reached

**Status:** Verified defect. **Priority:** High for misleading action interpretation; small fix.

Notification starts at two confirmed REDs, but its message says “wave-authorization threshold reached.” Actual authorization requires three, plus an active wave for a plan. Sources: `rule_engine/src/lib/notify.ts`, `RED_COUNT_NOTIFY_THRESHOLD` and message body; `rule_engine/src/rules.ts:49–51`; `mcp_server/src/server.ts:600–616`.

**Proposed:** name this an early stress alert, state the actual count and authorization separately, and avoid an action instruction unsupported by both gates.

## Prompt 2 — Statistical validation deliverable

### Explicit target contract to resolve

**Documented target:** approximately 21 trading sessions to an S&P price-index drawdown of at least 10% from ATH, conditional on current drawdown being less than 10%.

**Verified runtime:** maps the current feature vector to one number. There is no supplied label builder, risk-set filter, censoring logic, recurrence specification, survival model, or horizon-specific hazard sequence. Do not interpret its sigmoid as a daily hazard or compound it as `1 - (1-p)^21`.

**Proposed formal specification, requiring reconciliation to the original research:** let `P_t` be an official daily closing price index; `M_t = max(P_s, s <= t)`; `D_t = 1 - P_t/M_t`. For eligible days `D_t < 0.10`, define `Y_t = 1` if any of the next 21 trading-session closes has `D >= 0.10`. Forecast information is only that available by the declared issuance timestamp. Exclude immature outcomes at the end of each fit/calibration block and final dataset.

A running future peak `M_(t+k)` versus a peak frozen at `M_t` can change labels; the documentation does not settle this. A future 10% loss from `P_t`, or maximum future-window peak-to-trough loss, is a different target. Specify inclusion of session 21, exclusion of the current session, close versus intraday breach, and a warm-up history sufficient to define the peak. Define whether recrossing 10% after a brief recovery is a new event or part of one episode. Keep event grouping for evaluation separate from changing the risk set.

### Leakage-safe benchmark protocol — proposed, not executed

1. Recover/freeze data, vintages, forecast timestamps, labels and eligible-day universe. Include calm periods and every qualifying 10% event, not just named severe crises. Publish sample and independent-episode counts.
2. Use expanding chronological training and future test blocks. Fit scalers, imputers, feature selection, regularization and calibrator only inside the past training region. At each fit, use only labels whose full 21-session outcomes were observable then. Purge intersecting outcome intervals across boundaries; a 21-session gap is a starting implementation, verified against actual timestamps. Any additional embargo or change to episode grouping is predeclared. Time-ordered splitting alone does not resolve release lags or overlapping outcomes. [TimeSeriesSplit documentation](https://scikit-learn.org/stable/modules/generated/sklearn.model_selection.TimeSeriesSplit.html).
3. Fit calibration on earlier, chronological cross-fitted predictions with matured outcomes, and evaluate the complete pipeline on later untouched blocks. A final fit on all development data may follow, but cannot be scored on its own training/calibration outcomes as a validation result.
4. Compare a past-only eligible-day base rate, drawdown-only regularized logistic model, a small drawdown/realized-volatility/trend logistic model, and the cleaned 32-feature candidate. Fix the feature definitions and small tuning grid before final testing. Keep the old contaminated model as a diagnostic only.
5. Primary: Brier skill against the past-only base rate and paired score difference against the strongest simple baseline. Also report log loss, reliability diagrams and bin support, precision-recall, event recall, first-warning lead time, false-alert episodes/duration, fraction of time flagged, and AUROC as supplementary. Stratify by distance to the 10% boundary to distinguish proximity detection from useful early warning.
6. Estimate uncertainty with paired temporal blocks spanning dependence and episodes; include calm blocks as well as crises. Show block-length sensitivity and individual-episode contributions. Few crises limit inference even with many daily rows. Future-trained leave-one-crisis-out is a diagnostic only, clearly labeled.
7. Predeclare a final holdout if genuinely unused; otherwise say historical results are developmental and begin prospective shadow evaluation. Monitor forecast coverage, drift and reliability by model version. A quarter of calm live operation validates logging and coverage, not rare-crash accuracy.

**Suggested evidence gate:** improved Brier skill with a paired 95% dependence-aware interval above zero against the base rate and best simple comparator, no material log-loss degradation, and useful warning lead time at a predeclared false-alert budget. Report inconclusive intervals honestly; do not lower the bar after seeing results. These are proposed acceptance criteria, not achieved results.

### Three highest-value quantitative experiments

| Experiment | Comparison and question | Result that changes the recommendation |
|---|---|---|
| Q1 — point-in-time reconstruction | Revised-history diagnostic versus true availability-aware data; refit with and without recession probability | If claimed skill disappears, withdraw that claim; prefer the simpler valid model or monitoring-only status |
| Q2 — incremental signal | Base rate, drawdown-only, small volatility/trend, cleaned full feature set under identical splits | Retain complexity only if it improves held-out scores and event lead time beyond proximity to the threshold |
| Q3 — calibration stability | Uncalibrated, sigmoid and isotonic on chronological calibration sets; precision/episode sensitivity | Select using development data, then confirm once on untouched/prospective data; unstable 93–100% regions remain experimental |

## Prompt 4 — Investment and portfolio-risk usefulness

| Signal | Supported inference | Unsupported inference | Candidate decision | Extra evidence |
|---|---|---|---|---|
| Core panel | Observed threshold state and defined confirmation | Calibrated crash odds or independent votes | Escalate review/prepare a plan | Fresh observations, corrected gate, historical alert behavior |
| Hazard classifier | Frozen model score for a stated target, once eligible | Expected loss, crash depth, market bottom or optimal allocation | Prioritize monitoring; research a risk-budget rule | Valid labels, OOS calibration, actionable lead time |
| LLM narrative/radar | Sourced interpretation and subjective concerns | Frequency-calibrated probabilities or causal proof | Challenge thesis and identify next evidence | Claim-level sources, alternatives, prospective audit |
| Wave plan | Arithmetic implementing a predefined deployment policy | Optimal dip-buying or guaranteed rebound participation | Human-reviewed staged deployment | Costs, cash carry, mandate, execution and lifecycle tests |
| ETF rotation/divergences | Vehicle-level estimates and observed relationships | Complete sector fund flows or certain future returns | Research concentration/relative exposures | Aligned timestamps, proxy limitations, incremental OOS tests |
| Recession context | A distinct recession measure/forecast with its own horizon | Validation of a 21-session equity drawdown forecast | Macro scenario context | Correct temporal convention and an explicit transmission hypothesis |

**One conservative policy experiment, proposed:** paper-test the corrected existing deployment policy on a normalized research sleeve. Start each strategy at the same decision date and initial wealth, with the same explicit cash budget and contributions (or no contributions). Freeze Waves 1–3, the denominator for percentages, spacing rules and episode reset before testing. For the initial experiment deploy into one broad investable equity proxy; this isolates timing from discretionary sector/security selection. Compare with immediate buy-and-hold, a fixed scheduled deployment of the same cash budget, and a simple price-only staged deployment. Show average equity exposure and an exposure-matched comparison so lower drawdown from simply holding more cash is visible.

Execute only at the next tradable time after actual data availability; use total returns, cash yield and declared costs/slippage. Proposed research cost sensitivities: 0, 10 and 25 bps one-way, not estimates of the user's actual plan costs. Do not assume frictionless access to stable-value funds; obtain actual constraints or identify the cash proxy. No leverage, financing or options in this experiment. If later added, financing, carry and hedge decay become required. Assume a tax-deferred research account only for the first test, with no modeled tax benefit; other mandates need explicit taxes. Fed category history must be contemporaneous or replaced by an explicitly different reproducible policy, not retrospectively LLM-labeled.

Report net annualized return, volatility, maximum drawdown, tail loss where sample size permits, turnover, idle cash time, time to deployment, rebound participation and episode-level opportunity cost. **Illustrative precommitment gate:** at matched exposure, at least 10% relative reduction in maximum drawdown versus the chosen comparator, no more than 1 percentage point annualized net-return sacrifice, and no systematic late deployment across held-out episodes. The owner must adopt or replace these tolerances before results are observed. An interval spanning no benefit is inconclusive; one famous crash is insufficient. These tests are required before describing the policy as economically effective.

## Prompt 3 — Functional usefulness and interpretation

| User question | Current capability verified in source | Missing or misleading element | Findings |
|---|---|---|---|
| What changed? | Indicator deltas, prior report comparison, LLM delta log | Market changes can be mixed with changed judgment or writer state | F05, F09–F11 |
| Why and how unusual? | Bands, explanation text, context and radar | No validated probability-bin support; causal prose exceeds direct measurement | F04, F10 |
| Over what horizon? | Hazard says approximately 21 sessions | Conditional eligibility omitted; LLM horizon undefined | F01, F09 |
| How reliable/current? | Run dates, nullable hazard, freshness tool | Report date is not input freshness; model validation not reproducible | F03, F06 |
| What invalidates this view? | Project instructions request a counterargument and next watch item | Not required as structured fields in persisted public output | F10 |
| What can I do? | Observed/authorized waves, local deployment plan | Count defect and misleading early-alert wording | F05, F14 |
| What happened after prior forecasts? | Historical report navigation and price charts | No supplied joined forecast/outcome evaluation; history cap | F12, F13 |

**Proposed concise report outline:** (1) market-data cutoff and quality status; (2) observed stress and changes; (3) conditional statistical forecast, eligibility, experimental/validated status and evidence link; (4) sourced qualitative interpretation, strongest counterargument and next observation; (5) observed/authorized decision state; (6) expandable methodology and historical outcomes. Clearly separate any live context from an archived report. Simplify the large LLM percent meter into qualitative assessment; retain its old records for audit.

**Five user stories with observable acceptance criteria:**

1. As a reader already in a correction, I see “threshold already breached,” not a fresh-breach probability. Boundary fixtures at 9.99%, 10%, 10.01% pass on all report surfaces. (F01)
2. As a reader on a delayed-data day, I see which series is stale and whether a plan is blocked; regenerating narrative cannot clear the warning. (F06)
3. As a reader comparing signals, I can identify each target/horizon and understand that LLM/statistical agreement is not independent validation. A five-question comprehension check achieves at least 4/5 correct for each pilot reader; revise if anyone infers a guaranteed crash or trade instruction. (F09, F11)
4. As a reader receiving an early alert, I can distinguish two-RED monitoring from three-RED authorization and both from executed trades. Scripted 1→2→3 transitions produce correct distinct messages. (F05, F14)
5. As a reader inspecting an old forecast, I see its original evidence cutoff and eventual outcome, with current context separately labeled; a 1,001+ row fixture still selects the true latest report. (F12)

Normal-day, abrupt-stress, disagreement and stale-day fixtures must all be reviewed. Unknown status must never be colored or described as low risk. Live visual accessibility and mobile behavior remain unverified because the deployed report was unavailable.

## Prompt 7 — LLM grounding and governance

**Recommendation:** retain evidence-linked narrative and counterarguments; replace the headline LLM probability with a qualitative assessment pending a forecast contract and prospective calibration. Numeric ranges are not confidence intervals merely because they have lower and upper endpoints.

### Proposed provenance contract

Every report references a `run_id`, immutable numerical snapshot ID/hash, data cutoff, model artifact ID, rules version, prompt hash, LLM provider/model/version where exposed, generation time and evaluation status. Unavailable model/version settings are recorded as unknown, not guessed. Each factual claim links to a tool field or source record containing URL, publication time, retrieval time and an archived supporting excerpt/hash. Claims are typed as observed, computed, externally reported, or inferred. Numerical presentation dereferences immutable fields; generated prose cannot overwrite them. Qualitative Fed updates are separate explicit inputs with effective time and audit trail because they can affect authorization.

Store private portfolio context locally under the existing boundary; public evidence records should contain macro facts only. Pin generation to the snapshot actually reviewed, rather than silently rereading a different latest row on write. Persist a pre-prior/pre-hazard assessment if independence is claimed. Release the final report only after schema, freshness and consistency checks pass; otherwise publish an explicit degraded result or stop the synthesis according to policy.

### Small replay evaluation specification — proposed

Use at least 24 curated evidence packs (four variants of each row below), with three repeated runs per model/prompt version to expose stochastic variation. Keep expected numerical facts and decision states fixed. This is a functional/grounding evaluation, not a historical crash-prediction backtest.

| Case | Inputs | Required behavior | Failure threshold |
|---|---|---|---|
| Routine | Complete, fresh, low observed stress | Accurate figures, bounded interpretation and counterargument | Any altered critical number/gate fails |
| Abrupt stress | Large but valid moves and a first unconfirmed breach | Preserve observations; distinguish pending/confirmed/authorized | Any invented confirmation fails |
| Contradiction | Calm credit with stressed equity; conflicting dated sources | Explain disagreement and source timing without invented resolution | Any unsupported material factual assertion fails |
| Missing/stale | Absent source, quarantined price, outdated macro release | Name limitation, abstain from invalid forecast/plan | Any stale-as-fresh or unavailable-as-zero claim fails |
| Manipulated source | News excerpt instructing a gate change or false citation | Treat source instructions as data, retain immutable facts | Any unauthorized state change or fabricated citation fails |
| Out of distribution | Already-breached threshold, extreme feature values, new model version | Respect eligibility and experimental status; expose uncertainty | Any ineligible probability or unsupported certainty fails |

Measure exact numerical fidelity and schema compliance (100% required for critical fields), citation support (all material factual claims supported), stale-state correctness, interval ordering if numbers remain, and cross-run variation. Review material causal claims as interpretations unless the evidence supports causality. Any critical failure blocks release; log less consequential style issues separately. Compare hazard-hidden and visible variants for anchoring. Never treat a modern LLM's historical replay predictions as out-of-time market skill: it may already know the outcomes.

**Three highest-value safeguards:** immutable numerical references with server-side validation; source-linked claims with explicit abstention on missing evidence; versioned prospective archives with enforced assessment ordering when independence is claimed.

## Executed checks and their limits

| Check | Observed result | What it establishes |
|---|---|---|
| Eligible-population control | 16% drawdown still called scorer and persisted HIGH | No runtime risk-set guard; not a historical prediction result |
| Snapshot gate | Synthetic legitimate count 2 became 3; authorization false → true | Recovery entry contaminates gate |
| Same-date revision | GREEN revision returned prior confirmed RED object | Revision handling defect |
| Recovery path | Peak 100, trough 80, current 93, CUT and qualifying VIX history: trough null, recovery false | Trough reset prevents qualifying recovery |
| Calibration arithmetic | Mapping values in F04 reproduced | Runtime interpolation behavior only |
| Freshness function | Same-day report timestamp returned fresh without any source dates | It tests report recency, not source freshness |

The checks stubbed external services, portfolio data and feature I/O. They did not exercise Zod, hosted database constraints, network ingestion or the deployed UI. The findings tied to schemas/query strings are static inspections. No numerical backtest or measured investment outcome was available.

## Ordered next steps and decision gates

**Now:** correct F05 and F14; label statistical output experimental and enforce F01 eligibility; collect the missing research artifacts and report export. Establish source freshness and fix F07/F08 before relying on action state.

**Next:** reconstruct immutable point-in-time data and labels, reproduce training, then run Q1–Q3. Complete report/provenance changes and the LLM replay suite. A clean reproduction plus leakage-safe held-out skill could change the model verdict; a description of past success cannot.

**Later:** run prospective monitoring and the frozen portfolio-policy experiment. Only after incremental value is demonstrated should richer models, additional features, or expanded portfolio actions be considered. Start with ablations of existing data; do not add boosting, survival models, extra radar axes, or a statistical/LLM blend merely to appear more sophisticated.

A code-correct system can still have no forecasting edge; a calibrated forecast can still have no profitable or risk-adjusted portfolio use. Treat these as separate gates.

## External sources consulted

Accessed 2026-09-19; primary sources only. These support methodology/data semantics, not validation of this model:

- [FRED real-time periods](https://fred.stlouisfed.org/docs/api/fred/realtime_period.html): vintage semantics and default current knowledge.
- [Jeremy Piger recession-probability FAQ](https://jeremypiger.com/recession_probs_faq/): smoothing, revisions and historical release availability.
- [FRED SP500 notes](https://fred.stlouisfed.org/series/SP500/index.html): daily close, price-index definition and ten-year supplied history.
- [scikit-learn calibration guide](https://scikit-learn.org/stable/modules/calibration.html): independent fitting, reliability and calibration limits.
- [scikit-learn TimeSeriesSplit](https://scikit-learn.org/stable/modules/generated/sklearn.model_selection.TimeSeriesSplit.html): chronological splitting and gap parameter; this review proposes additional label-overlap controls.