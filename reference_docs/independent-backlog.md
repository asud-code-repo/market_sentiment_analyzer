# Improvement backlog — Market Sentiment Analyzer

Prepared 2026-09-19 from `market_sentiment_analyzer-main(2).zip`.

ZIP SHA-256: `ffa33233b7bf75d1f10ab14d0f94143497ae03e061bd60aeaf192c94f8a8d4f3`. No authoritative commit SHA was available. Paths and line numbers refer to that snapshot. Companion assessment: `independent-review.md`; this backlog also contains the context needed to use it independently.

**Purpose:** improve correctness, statistical validity and practical usefulness. This document proposes work; no implementation, production changes, statistical backtest, or demonstrated accuracy uplift occurred during the review. The current public URL could not be retrieved, so presentation findings concern repository source. The actual deployed version and affected historical records remain to be checked.

## Handoff instructions for a fresh Claude Code session

1. Locate the files and symbols below; compare the current branch with the reviewed snapshot before assuming defects still exist. Record the current commit. Do not overwrite unrelated work.
2. Preserve separate mechanical indicators, statistical scores and LLM judgments. Preserve the hazard model's non-gating role. Never blend percentages as a shortcut.
3. Obtain explicit implementation scope from the owner before implementing this review. Once authorized, use isolated changes and meaningful regression fixtures; do not run ingestion, write production records, place trades or publish a report as part of testing.
4. Do not hand-edit learned coefficients or the calibration table. Feature removal/replacement requires joint retraining and a new versioned artifact.
5. Classify outcomes as correctness fixes, research results, or inconclusive evidence. Missing evidence is not a failed model. Keep empirical acceptance criteria fixed before seeing test outcomes.
6. Do not retrospectively regenerate LLM forecasts and call them out-of-time predictions. Archive genuine prospective outputs instead.

The system uses TypeScript ingestion → Supabase observations → deterministic `classify()` → local MCP tools → Claude-generated qualitative reports and web rendering. The statistical component is frozen 32-feature logistic regression with isotonic interpolation for a documented 21-session, 10%-from-ATH breach target. Its training pipeline and underlying validation artifacts are not in the snapshot. The five numeric gate indicators plus a judgment-based Fed category control discretionary deployment; the statistical model does not.

## Five workstreams and evidence gates

| Workstream | Items | Gate before relying on results |
|---|---|---|
| 1. Correct target and episode semantics | B01, B07 | Explicit eligible population and labels; boundary/lifecycle tests |
| 2. Point-in-time data and freshness | B02, B06 | Availability-aware reconstruction and source-level quality checks |
| 3. Reproducible model validation | B03, B04, B13 | Complete-pipeline out-of-sample value beyond simple baselines |
| 4. Safe decision state and economic usefulness | B05, B07, B11, B12 | Correct authorization first; then frozen cost-aware policy comparison |
| 5. Evidence-matched reports and LLM governance | B08, B09, B10 | Interpretable claims, source fidelity, replayable provenance and true latest/history |

**Effort convention:** hands-on engineering/research days, approximately 6 productive hours/day, one experienced TypeScript/Python practitioner. S = up to 2 days; M = 3–7 days; L = 8+ days. Ranges include targeted verification and documentation, not production deployment or elapsed waiting for data/rare events. Data recovery may exceed estimates. Items share infrastructure; do not blindly sum ranges. Research success means trustworthy evidence, which may show no benefit.

## Finding index

| ID | Evidence class | Finding |
|---|---|---|
| F01 | Reproduced defect; label detail unknown | Conditional hazard still scored after the 10% threshold is already breached |
| F02 | Verified data/provenance limitation; training contamination documented | Current-vintage upserts and observation-date joins do not provide point-in-time research history |
| F03 | Unverified research claim | Training, splits, predictions and bootstrap evidence absent from supplied snapshot |
| F04 | Verified arithmetic; research hypothesis | Calibration maps a broad raw range to 92.7%, reaches 100%, and has steep local transitions |
| F05 | Reproduced defect | Snapshot writer counts `vix_recovery` as a gating RED, potentially changing authorization |
| F06 | Verified freshness defect | New report timestamps can make copied stale observations appear current |
| F07 | Reproduced revision defect; verified continuity limitation | Same-date changed color ignored; gaps do not break confirmation counters |
| F08 | Reproduced recovery defect | Trough cleared before qualifying rebound is evaluated |
| F09 | Verified semantics/presentation gap | Headline LLM percentage has no enforced event/horizon or range meaning |
| F10 | Verified governance limitation | No enforced claim-to-source, model/prompt, numerical consistency or phase provenance contract |
| F11 | Verified exposure; anchoring unmeasured | LLM sees hazard output before its own estimate; agreement is not independent evidence |
| F12 | Verified conditional UI defect | Ascending first-1,000 history can misidentify latest; current context lacks displayed source dates |
| F13 | Economic evidence gap | Encoded deployment arithmetic has no supplied cost-aware out-of-sample value demonstration |
| F14 | Verified wording defect | Two-RED notification incorrectly claims wave authorization was reached |

## Correctness and interpretation actions

### B01 — Enforce eligibility and specify the statistical target

- **Findings:** F01; related F03, F08. **Priority:** High; the displayed probability can answer the wrong question precisely when markets are stressed.
- **Verified components:** `rule_engine/src/classify.ts:97–109`; `rule_engine/src/hazardModel.ts:119–135`; `mcp_server/src/server.ts:106–116`; `dashboard_site/index.html:1018–1038`; `supabase/migrations/20260826000000_hazard_model_10pct.sql`; hazard/rules documentation and report template.
- **Proposed change:** add explicit eligibility/status/reason fields and do not score a fresh-breach forecast at current drawdown >=10%. Distinguish ineligible, missing/stale, failed and experimental states; do not turn them into zero or 100%. Define price series, peak, 21-session boundary, information cutoff, re-entry eligibility and label maturity. Recover the original training contract before asserting parity. A proposed new label is not automatically the old trained label.
- **Dependencies:** none for honest eligibility display; B03 for matching the fitted artifact; B07 for shared episode terminology.
- **Acceptance/validation:** fixtures at 9.99%, 10%, 10.01%; scorer not invoked for ineligible state; all surfaces show the same reason. Separate label fixtures cover a new high inside the future window, exact session-21 crossing, session-22 crossing, re-crossing, and an unfinished future window. Explicitly distinguish running future peak from peak frozen at forecast date. No inference of a new 10% loss from today's price.
- **Effort:** S–M, 2–4 days; assumes schema changes and rendering can be tested locally. Original-label recovery is separately estimated in B03.
- **Expected benefit / downside:** correct interpretation, not proven better predictions; some days will intentionally have no forecast.

### B05 — Remove recovery state from authorization and centralize the gate

- **Findings:** F05. **Priority:** Critical: a report write can enable a dollar deployment plan without changed market inputs. Actual historical incidence is unknown.
- **Verified components:** `rule_engine/src/classify.ts:73–84,132–139`; `mcp_server/src/lib/supabase.ts:356–360`; `rule_engine/src/rules.ts`; `mcp_server/src/server.ts:600–621`.
- **Proposed change:** allowlist `vix`, `hy_spread`, `sp_drawdown`, `treasury_10y`, `sahm_rule`; add only the explicit Fed category. Share one pure gate calculation across writers or enforce tested parity if packaging prevents reuse. Recovery keys must never affect the result. Pin writes to the numerical snapshot reviewed by the LLM.
- **Dependencies:** none for the count fix; B09 for immutable snapshot linkage. After fixing, inspect authorized historical records against source state; recommend corrections separately rather than silently rewriting history.
- **Acceptance/validation:** VIX 30/AMBER, HY RED, Fed CUT, drawdown 16%/AMBER, other indicators non-RED, and confirmed recovery RED must remain count 2 and unauthorized in both writers. Vary every core color/confirmation and Fed category; counts never exceed six; add arbitrary non-gating keys without changing results. Unchanged Fed input must preserve all aggregate gate values. `get_deployment_plan` must decline this case.
- **Effort:** S, 1–2 days; assumes extractable pure gate logic and mocked persistence.
- **Expected benefit / downside:** removes false authorization from this code path; shared code requires coordination between two TypeScript packages.

### B06 — Make freshness and confirmation depend on the observations

- **Findings:** F06, F07; related F02. **Priority:** High: stale or revised inputs can invalidate both predictions and decision state.
- **Verified components:** `mcp_server/src/lib/freshness.ts`; `mcp_server/src/lib/supabase.ts`, `writeSnapshot`; `mcp_server/src/server.ts`, indicator/plan tools; `ingestion/src/ingest.ts`; `rule_engine/src/rules.ts:122–145`; `rule_engine/src/lib/seriesDelta.ts:102–119`; `rule_engine/src/hazardModel.ts`, `requireLevel`.
- **Proposed change:** preserve source run identity, observation/release times and per-series health. Enforce cadence-aware freshness before returning decision-ready state and on write. Quarantined required inputs create a degraded state. Handle changed values/colors on the same observation date without incrementing an independent observation count; define out-of-order and missing-session behavior. Verify actual trading-session completeness before row-count lags or continuous-persistence claims. Relabel counters as observations where appropriate.
- **Dependencies:** B02 supplies timestamp conventions; B05 supplies the correct gate. Freshness containment can precede full vintage reconstruction.
- **Acceptance/validation:** a new narrative cannot make an old core snapshot fresh; a frozen VIX source cannot pass because ingestion ran today; monthly Sahm follows its own schedule; weekends/holidays and release lags behave as specified. Same-date RED→GREEN revision clears inappropriate RED confirmation. Missing sessions cannot silently count as sustained readings. Repeated unchanged observations do not increment counters. Core invalidity blocks a new actionable plan and remains visible on reports.
- **Effort:** M, 4–7 days; assumes cadence metadata and a usable market calendar. Does not require paid data.
- **Expected benefit / downside:** prevents stale certainty; may reduce forecast availability and requires explicit handling of legitimate lags.

### B07 — Correct recovery episode lifecycle

- **Findings:** F08, F13. **Priority:** High: recovery status can miss a valid rebound and distort re-entry/deployment evaluation.
- **Verified components:** `rule_engine/src/classify.ts:118–161`; `rule_engine/src/rules.ts:91–94`; `supabase/migrations/20260816000000_recovery_tracking.sql`; `mcp_server/src/lib/waveDeploymentState.ts`; rules Stage 4.
- **Proposed change:** retain the trough through recovery evaluation; distinguish active drawdown, recovering episode and closed episode with an explicit identifier and reset policy. Define how repeated 10% crossings and a new ATH interact. Decide how Fed CUT recency is recorded. Specify how executed waves reset for a genuinely new episode without erasing execution history.
- **Dependencies:** owner agreement on episode closure and confirmation semantics; B06 for continuity; B11 before claiming the policy is economically better.
- **Acceptance/validation:** peak 100 → trough 80 → current 93, Fed CUT, and 15 qualifying VIX observations must recognize the 16.25% rebound rather than erase its reference first. Cover deeper renewed lows, 9.9%/10.1% oscillation, delayed VIX confirmation, repeated runs and a genuinely new episode. No accidental redeployment of already executed waves. Audit historical-path differences before release.
- **Effort:** M, 3–5 days; assumes no automated trading and a modest state migration.
- **Expected benefit / downside:** fixes lifecycle consistency; reset choices may change behavior and need explicit review.

### B08 — Replace misleading report emphasis and define subjective fields

- **Findings:** F09, F11; related F01, F03, F04. **Priority:** High: prominent numerical presentation can imply evidence the system lacks.
- **Verified components:** `dashboard_site/index.html:1018–1038,1137–1174`; `reference_docs/rules/dashboard-template.html`; `reference_docs/rules/project-instructions.md`; `mcp_server/src/server.ts:300–348`; qualitative schemas/migrations.
- **Proposed change:** lead with observed stress, data quality and a qualitative assessment. Label statistical output experimental pending validation. State target, conditioning and horizon at point of use. Remove the LLM percentage as the main meter; preserve old subjective values in history. If future numerical LLM forecasting is retained, require target/horizon, range semantics and `low <= point <= high`; define mutually exclusive scenario outcomes. Label radar scores as subjective assessments, not probabilities. Do not convert arbitrary stress points directly to percentages. Either disclose hazard-informed narrative or withhold the hazard until a committed assessment is recorded.
- **Dependencies:** B01 status semantics; B09 for enforced phase/provenance controls. Cosmetic changes can precede model research.
- **Acceptance/validation:** readers can distinguish observation, experimental forecast, opinion and authorization on normal/stress/disagreement/stale fixtures. No claim of validated accuracy without a linked evidence artifact. Five-question comprehension check: >=4 correct per pilot reader; revise if any infer a guarantee or automatic trade. Invalid ranges are rejected if numerical fields remain. Historical subjective percentages are not retroactively relabeled calibrated probabilities.
- **Effort:** M, 3–5 days; assumes existing HTML surfaces and a small manual pilot, not a redesign.
- **Expected benefit / downside:** less false precision; may feel less numerically decisive while evidence is rebuilt.

### B09 — Add a minimal provenance contract and LLM evaluation gate

- **Findings:** F10, F11, F09; related F05, F06. **Priority:** High: factual fidelity and reproducibility are currently mostly prompt conventions.
- **Verified components:** `mcp_server/src/server.ts`, qualitative write schemas and tool outputs; `mcp_server/src/lib/supabase.ts`, report writers; `mcp_server/src/lib/tokenLog.ts`; `reference_docs/rules/project-instructions.md`; report schemas and renderers. Evaluation harness and provenance schema would be new components.
- **Proposed change:** store run ID, immutable numerical snapshot/hash, artifact/rules/prompt versions, model identifier where available, source/publication/retrieval metadata, and evidence-linked claims. Label each claim observed/computed/reported/inferred. Numerical prose should dereference validated fields. Pin report writes to the viewed snapshot. Persist a structured pre-prior/pre-hazard draft if claiming independence; do not depend on private working reasoning as a commitment record. External text must not act as instructions. Keep personal financial evidence local under the existing boundary.
- **Dependencies:** B02/B06 timestamp contract, B08 output contract; can initially use local JSON fixtures and manifests.
- **Acceptance/validation:** at least 24 packs, four each for routine, abrupt stress, contradiction, missing/stale, manipulated-source and out-of-distribution cases; three runs per version. Require 100% critical-number/gate fidelity, all material factual claims supported, correct stale/eligibility behavior, no invented citations and no successful instruction-driven state change. Any critical failure blocks release. Record nondeterminism; compare hazard-visible/hidden cases. Archive sources so numerical facts and citations can be replayed without live browsing. Unknown model settings are explicit, not invented.
- **Effort:** L, 8–12 days; assumes model identifiers/export hooks are available. If Claude Desktop cannot expose them, implement honest partial provenance and record the limitation rather than promise exact deterministic LLM replay.
- **Expected benefit / downside:** measurable factual quality and change control; introduces review/storage overhead and does not itself establish forecast skill.

### B10 — Correct latest/history retrieval and report time context

- **Findings:** F12, F06. **Priority:** Medium now; high when 1,000 reports exist or stale context affects a decision.
- **Verified components:** `dashboard_site/index.html:335–362,1450–1486,1679`; archived snapshot schema; `classify.ts`, raw source data.
- **Proposed change:** fetch true latest explicitly and paginate history with stable ordering. Display source dates on context cards. Preserve the existing disclosure that live context is independent of selected history, or offer a genuinely archived as-of mode after B02/B09. Add statistical forecast/status/outcome history when valid labels exist.
- **Dependencies:** none for retrieval/dates; B02/B09 for exact historical evidence, B01/B04 for meaningful outcomes.
- **Acceptance/validation:** 1,001+ rows with mixed automated/full reports must return the true latest, with every page navigable. A selected past report cannot imply current context was known then. Every context value has a date/status; no unavailable value becomes zero. Observed outcomes appear only after labels mature.
- **Effort:** S–M, 2–4 days for retrieval and dates; full archived view adds 3–5 days after provenance exists.
- **Expected benefit / downside:** trustworthy navigation and comparison; archive mode adds storage and UI complexity.

### B12 — Correct early-alert wording

- **Findings:** F14. **Priority:** High for interpretation; immediate small fix.
- **Verified components:** `rule_engine/src/lib/notify.ts`, threshold and body; `rule_engine/src/rules.ts:49–51`; deployment-plan gate.
- **Proposed change:** keep two-RED notification as an early stress alert if desired, but explicitly state it is below the three-RED authorization threshold; report actual authorization and active-wave status separately. Do not silently change the alert threshold to mask the wording defect.
- **Dependencies:** none; ensure B05 gives correct counts.
- **Acceptance/validation:** mocked 1→2 sends one early alert with no authorization claim; repeated 2 does not repeat; 2→3 and wave-active/inactive states are described accurately under the chosen notification policy. No live notification is sent in tests.
- **Effort:** S, 0.5–1 day.
- **Expected benefit / downside:** removes a false action cue; threshold utility remains an empirical policy question.

## Research and validation actions — outcomes not guaranteed

### B02 — Build point-in-time data and immutable scoring inputs

- **Findings:** F02, F06; related F03/F04. **Priority:** High: a model validated with unavailable historical information cannot establish real-time skill.
- **Verified components:** `ingestion/src/sources/fred.ts`, latest/history functions; `ingestion/src/lib/supabase.ts:32–49`; base `data_points` schema; `rule_engine/src/hazardModel.ts:173–180,266–315`; `rule_engine/src/lib/seriesDelta.ts`; `classify.ts`, output snapshot. Vintage warehouse/research export and artifact manifest are proposed new components.
- **Proposed change:** distinguish observation, release, vintage and acquisition times. Build historical features from information available at each forecast cutoff. Preserve all 32 feature values with source lineage and artifact hash for each issued forecast. Audit current-level versus lag-anchor timing, SP500 missing sessions, running-peak history, revisions and stale series. Remove or replace recession probability through a complete refit if valid historical vintages are unavailable. Do not assume all macro series become safe once one feature is removed.
- **Dependencies:** B01 target, B03 original research/source recovery. Keep prospective capture moving even if old data cannot be recovered.
- **Acceptance/validation:** changing a future release/revision cannot change an earlier frozen feature vector; no release timestamp exceeds issuance time. Independent reconstruction matches saved inputs. Sample dates span every feature frequency and crisis boundary. Historical price/peak data cover the intended period; a 1900 query start alone is not evidence of coverage. Document series-by-series coverage and exclusions. Compare revised-history diagnostic versus true point-in-time results without representing the former as deployable performance.
- **Effort:** L, 10–20 days; assumes legally accessible vintages and a suitable older equity series. Otherwise timebox a 3-day feasibility audit and explicitly narrow the research period.
- **Hypothesized benefit / downside:** more credible performance estimates; apparent skill may decline and the usable sample may shrink.
- **Primary references:** [FRED real-time periods](https://fred.stlouisfed.org/docs/api/fred/realtime_period.html), [Piger FAQ](https://jeremypiger.com/recession_probs_faq/), [FRED SP500 notes](https://fred.stlouisfed.org/series/SP500/index.html), accessed 2026-09-19. These establish source semantics, not this model's realized leakage magnitude.

### B03 — Recover the research and reproduce the frozen artifact

- **Findings:** F03, F04, F02. **Priority:** High: validity claims cannot be audited from copied constants alone.
- **Verified components:** `rule_engine/src/hazardModel.ts:1–166`; hazard explanation and rules statistical section. Original `hazard_model_10pct_artifact.json`, training scripts and evaluation datasets are named/documented but absent from the ZIP.
- **Proposed change:** obtain original data manifests, labels, folds, preprocessing/regularization settings, sample/class weights, calibrator, prediction records and bootstrap outputs. Create a versioned research pipeline and generated production artifact; avoid hand-copied coefficients. Separate expanding chronological evaluation from future-trained leave-one-crisis-out diagnostics. Identify prior reuse of intended holdout data.
- **Dependencies:** owner supplies original artifacts if recoverable; B02 for credible historical reconstruction. If originals cannot be recovered, call the new effort a rebuild, not reproduction.
- **Acceptance/validation:** raw and calibrated predictions match the full-precision research artifact on fixed feature vectors within a documented tolerance (proposed absolute probability tolerance 1e-6); scores around all knots, ties and endpoint handling tested. If rounded constants prevent this, quantify differences and regenerate a new artifact after approval. Publish eligible-day/event counts, split boundaries, mature-label cutoffs and actual metrics. No “confirmed edge” claim remains without reproducible evidence.
- **Effort:** M, 3–6 days if artifacts exist; L, 8–15 days to rebuild, excluding B02. Timebox initial recovery rather than guessing missing settings.
- **Hypothesized benefit / downside:** auditable research-to-production parity; may reveal irreproducible prior claims.

### B04 — Run leakage-safe baselines and calibration experiments

- **Findings:** F03, F04, F13; related F01/F02. **Priority:** High: directly tests whether the model adds useful predictive information.
- **Components:** existing scoring functions and recovered research pipeline; new versioned prediction/evaluation tables and reports. No existing evaluator was found.
- **Proposed experiments:** Q1 compares point-in-time versus revised-data diagnostics and refits with/without recession probability; Q2 compares historical eligible-day base rate, drawdown-only logistic, small drawdown/realized-volatility/trend logistic and cleaned full model; Q3 compares no calibration, sigmoid and isotonic with precision/episode sensitivity. Freeze a small tuning grid on development data.
- **Protocol:** expanding chronological splits; train-only transformations/tuning; purge training/calibration labels whose outcome intervals overlap later blocks, starting with a verified 21-session maturity gap; fit calibrator on earlier chronological cross-fitted predictions; evaluate the whole pipeline on future blocks. Include quiet periods and every qualifying event. Reserve a genuinely untouched final sample or label all past testing developmental and collect prospective data. No retrospective LLM forecasts.
- **Dependencies:** B01–B03. Do not evaluate a cleaner feature set with old jointly fitted coefficients.
- **Acceptance/validation:** report Brier skill, paired difference versus strongest simple baseline, log loss, reliability-bin counts/episode support, precision-recall, event recall, warning lead time and false-alarm duration. Use paired temporal-block/episode-aware uncertainty including quiet blocks; test block-length sensitivity. Show performance conditional on distance to the threshold. Suggested promotion gate: 95% interval above zero for skill versus base rate and best simple comparator, no material log-loss degradation, and predeclared useful lead time/false-alert budget. Fix practical tolerances before final test. If inconclusive, retain experimental status; fewer features or an uncalibrated research score may be the honest result. Metric-only clipping for log loss must be documented and cannot silently alter production predictions.
- **Effort:** L, 8–12 days once data/reproduction are ready; prospective rare-event evidence has indeterminate elapsed time.
- **Hypothesized benefit / downside:** determines whether improvement is real; no guarantee any model beats the simple baseline. Avoid repeated searches over famous crashes.
- **Primary references:** [scikit-learn calibration](https://scikit-learn.org/stable/modules/calibration.html), [TimeSeriesSplit](https://scikit-learn.org/stable/modules/generated/sklearn.model_selection.TimeSeriesSplit.html), accessed 2026-09-19. Label-overlap and episode protocols here are proposed review requirements.

### B11 — Test deployment usefulness separately from prediction skill

- **Findings:** F13; related F05/F07/F08. **Priority:** High before describing allocation outputs as empirically supported; after correctness work.
- **Verified components:** `rule_engine/src/rules.ts:49–73`; `mcp_server/src/lib/waveDeployment.ts`; `mcp_server/src/lib/waveDeploymentState.ts`; `mcp_server/src/server.ts:572–655`. Historical policy evaluator would be new.
- **Proposed change/experiment:** paper-test a frozen corrected wave policy with one broad investable equity proxy first, to isolate timing. Define initial cash budget, original-versus-remaining denominator, contribution schedule, spacing, episode reset and reinvestment/re-entry. Compare immediate buy-and-hold, scheduled deployment of the same budget and simple price-only staged deployment. Use common initial wealth/date and report an exposure-matched comparison. Do not introduce hazard gating as an untested shortcut.
- **Dependencies:** B05–B07/B12; verified investable total returns/cash returns, actual fund restrictions and a contemporaneous Fed-category history or an explicitly different reproducible proxy policy. Owner defines mandate and acceptable opportunity cost before results. B04 is required only if subsequently testing a hazard-based policy.
- **Acceptance/validation:** next-tradable-time execution after information availability; cash yield, costs/slippage and turnover included. Research cost sensitivities 0/10/25 bps one-way, not asserted actual costs. First experiment: no leverage/options, tax-deferred account assumption; other mandates need financing/hedge carry/taxes explicitly. Report net return, volatility, max drawdown, tail loss where estimable, idle cash, rebound participation and episode contributions. Proposed economic gate to adopt before testing: >=10% relative max-drawdown reduction at matched exposure, <=1 percentage point annualized net-return sacrifice, no systematic late deployment across held-out episodes. Require uncertainty and robustness rather than one favorable crisis. If mandate/data cannot support this test, limit conclusions to monitoring usefulness.
- **Effort:** L, 8–15 days after data/mandate access; excludes data licensing and waiting for prospective outcomes.
- **Hypothesized benefit / downside:** determines risk/return and opportunity cost; a statistically useful forecast may still fail this economic gate.

### B13 — Research additional predictors or model classes only after baseline evidence

- **Findings:** F03, F04, F13. **Priority:** Low/deferred: added complexity is not an accuracy fix.
- **Components:** proposed research pipeline; `hazardModel.ts` only after successful evaluation and a versioned artifact export.
- **Proposed change:** first ablate existing redundant macro/credit/volatility features. Test stable transformations of trending levels, or one additional signal, only with verified point-in-time history and a predeclared rationale. Compare any discrete-time survival/GAM/boosting candidate to the small regularized logistic baseline. Survival modeling requires a genuine at-risk/event-time dataset and independently evaluated horizon probabilities.
- **Dependencies:** B01–B04 completed; only proceed if a specific residual failure mode and enough independent events justify the experiment.
- **Acceptance/validation:** hold data, target and evaluation protocol constant; account for multiple attempted variants; show incremental held-out performance and maintenance cost. Stop if benefit is inconclusive. No promotion from in-sample fit, AUROC alone or reviewer enthusiasm. Do not infer that a data source does not exist merely because current code comments say so; verify availability only when pursuing that candidate.
- **Effort:** M, 3–5 days per narrowly scoped experiment after infrastructure; new data engineering is extra.
- **Hypothesized benefit / downside:** possible incremental signal; high risk of overfit and maintenance burden with few independent crises.

## Executed review evidence versus future acceptance tests

Review checks used Node v24.19.0 with TypeScript stripping and in-memory I/O stubs. They executed extracted source logic, without repository changes or live services:

| Fixture | Actual result in reviewed code |
|---|---|
| 16% current drawdown, model feature I/O stubbed (actual drawdown, other features at training means) | `classify()` still invoked scorer; stored HIGH |
| Core confirmed count 2 plus confirmed RED `vix_recovery` | `writeSnapshot()` produced count 3 and authorization true |
| Same observation date, previous confirmed RED, new GREEN | `computeConfirmation()` returned prior RED state |
| Peak 100, trough 80, current 93; CUT; 15 qualifying VIX observations | Trough cleared; recovery remained false |
| Calibration raw 0.2058 vs 0.2059 | Calibrated 0.6667 vs 0.8 |
| Calibration raw 0.3 or 0.8 | Both calibrated 0.927 |

These confirm implementation behavior only. Zod/hosted database/network paths and live rendering were not exercised. Future acceptance tests above are proposals, not completed work.

## Recommended order and stop conditions

**Immediate correctness/communication:** B05 and B12; B01 and the experimental-status portion of B08. B06/B07 before trusting deployment/recovery state. These require no claimed predictive uplift.

**Evidence foundation:** B03 artifact recovery and B02 point-in-time capture/reconstruction. B09 can begin with local evidence fixtures; B10 retrieval fixes can proceed independently.

**Validation:** B04 Q1–Q3, then genuine prospective shadow logging. B11 tests economic usefulness after policy state is correct and mandate/data are defined.

**Do not build yet:** a statistical/LLM percentage blend, more radar axes, auto-trading, a larger model, or a new 20% target justified by the existing 10% results. B13 remains optional.

Stop a research branch if historical availability cannot be established, final evaluation has repeatedly influenced tuning, or independent event support is inadequate. Report the resulting limitation rather than substituting revised data, hindsight labels or a favorable metric. Successful implementation of this backlog means honest, reproducible evidence and correct behavior; it does not guarantee better crash prediction or investment returns.