# Backlog

Things deliberately deferred, not forgotten. Grouped by area, not priority.
Resolved items are removed once done rather than kept struck-through —
full history of what was built and how lives in project memory, not here.

## Security & access

- **Cloudflare Access policy coverage of preview-deployment URLs** on
  `full_report_site`. A preview deployment gets a separate hostname from
  production, and the Access Application's domain config only currently
  covers the production URL. Low priority for a single-user page — revisit
  if it ever matters.

## Data & infrastructure

- **Wave 2/3 threshold calibration — still genuinely open.** Wave triggers
  are ATH-relative drawdown % (16/24/35, paired with VIX 28/35/45) rather
  than fixed nominal S&P levels, which fixed a *decay* problem (a fixed
  level like "S&P ≤ 6,200" quietly means less over time as the index
  itself rises) but not whether those specific bars are the *right* ones.
  Backtested against real 2016–2026
  history: Wave 3 never fired in 2020 despite VIX peaking at 82 (drawdown
  missed the 35% bar by ~1pt); Wave 2 never fired in 2022 despite a real
  24%+ drawdown, because VIX never sustained above 35 in that "grinding"
  bear market. An external review independently proposed VIX-as-accelerator
  rather than a hard gate — this needs the same real-backtest treatment as
  everything else here, not a quick sign-off. Belongs with the hazard-model
  work below, not a standalone tweak.

- **Cross-indicator divergence detection — still open**: rolling-
  correlation infrastructure, and a regime-dependent 10yr-vs-equities pair
  (its intended meaning genuinely differs by macro regime, so it needs the
  regime concept from the hazard-model work below to mean anything).

- **Recovery-transition detection (Stage 4) — still open**: the
  month-by-month execution tracking (which glide-path step you're actually
  on) — no equivalent of `wave_deployment_state.yaml`/`record_wave_deployment`
  exists for this yet.

- **Market-internals / breadth proxy via relative ETF performance — partially
  built.** Small-cap vs. large-cap (Russell 2000 via IWM vs. S&P 500 via SPY)
  shipped 2026-08-27 as a `get_context_indicators`/dashboard contextual
  reading, tracked independently of the BrokerageLink watchlist so a
  Portfolio Opportunity Review's full-replacement sync can't delete it. Two
  more pairs from the same original idea remain unbuilt: equal-weight vs.
  cap-weight S&P (RSP vs. SPY, breadth without small-cap-specific framing)
  and bank-sector vs. S&P (KBE/KRE vs. SPY, credit-sector-specific stress) —
  same mechanism (`BREADTH_TICKERS` in `ingestion/src/sources/massive.ts`,
  same relative-return-spread pattern in `get_context_indicators`), just not
  extended to these two yet.

- **Sector capital-rotation — v1 shipped 2026-09-15, two pieces
  deliberately descoped.** `sector_rotation` (11 SPDRs + SPY + GLD, real
  SSGA-sourced flow) is live. Explicitly deferred by user decision, not
  forgotten:
  - **Z.1 macro-transactions panel** — 4 FRED series (household/foreign
    Treasury and equity acquisitions) independently verified feasible the
    same session, not yet wired into `get_context_indicators`.
  - **TLT/DBC in the rotation panel** — different issuers (iShares/
    Invesco) than the SPDR suite; no SSGA-equivalent free NAV-history
    source confirmed for either. Would need per-issuer verification before
    adding, or a Massive-price-only fallback (no real flow signal, just a
    return figure, same caveat this whole search was trying to move past).
  - **Total return (with dividends)** — v1 uses NAV price-only return.
    Massive's `/stocks/v1/dividends` endpoint was verified working and
    free; combining it with SSGA's NAV series for a proper total-return
    calc is a natural fast-follow, not done to keep v1 single-source.

- **Per-series data-quality/freshness metadata.** The whole-run freshness
  check exists; nothing per-series. A "green" panel could still be built
  from a mix of today's VIX, last week's claims, and a silently-stale
  monthly series. Concrete field list proposed: latest observation date,
  source publication timestamp, expected cadence, days since latest valid
  observation, last successful ingestion time, data-quality state
  (current/expected-lag/stale/failed/quarantined). Not started.

- **Tier 2 confidence-escalation rule has zero code enforcement.** Surfaced
  2026-09-15 while reviewing an external (GPT) critique of a proposed
  capital-rotation feature — checked and confirmed via grep, not asserted:
  `crash-check-rules.md`'s "3+ Tier 2 indicators moving adverse across 4+
  consecutive weekly readings must raise the confidence qualifier" rule
  (Signal Tiering & Confirmation Windows section) has no match anywhere in
  `rule_engine` or `mcp_server` — it is pure prose, trusting the LLM to
  remember and compare Tier 2 indicator trends across 4+ weekly reports
  purely from memory. This already silently applies to every Tier 2 field
  shipped so far (small-cap breadth, gold, Bitcoin), not just anything added
  later. Same class of bug this project has fixed three times already (the
  rate-reset trigger, the Fed-event/inflation-print calendar,
  `trigger_status` dedup) — "prose instructions for anything with one
  objectively correct answer are the wrong tool, even when very explicit."
  Not started; would need per-Tier-2-indicator trend tracking across
  ingestion dates, deterministically computed rather than LLM-recalled.

- **`rules_version` stamped on every `crash_checks` row.** Small, cheap,
  independent of the bigger "shared executable rules package" idea (rules
  are still duplicated across the prose doc, `rule_engine`, `mcp_server`,
  and `dashboard_site` — no compile-time guarantee they stay in sync).
  Versioning historical rows is groundwork the hazard-model backtesting
  work will need regardless of when the shared-package refactor happens.
  Not started.

- **Formal test suite.** Every change this project has made has been
  verified with `tsc --noEmit` plus manual/throwaway scripts — real, but
  not durable. Concrete scope already identified: threshold boundaries,
  missing/stale series behavior, 2-day confirmation semantics, recovery
  state transitions, wave-authorized-vs-observed-only states, cumulative
  deployment logic, idempotent wave-execution recording, divergence-
  direction logic, no-dollar-figure persistence guardrails. Buildable now,
  doesn't need the hazard-model work first. Not started.

- **Allocation assumptions inside the crash-type layers — unexamined.**
  Surfaced 2026-08-17 via a refreshed investment-model review: the Stage 3
  crash-type sleeves embed untested economic bets — REITs aren't reliably
  defensive in inflationary/high-real-yield regimes, Healthcare stays
  equity beta (not liquidity protection), Energy can be cyclical in a
  recession despite hedging supply shocks, TIPS can lose value when real
  yields rise, Gold isn't a universal credit-crisis hedge, the AI/tech
  single-name Type-D layer is concentrated security selection dressed up
  as a crash protocol, and the fixed 6-month recovery schedule assumes
  recoveries share a shape (2009/2020/1974/2002 didn't). Different kind of
  work than the hazard model — asset-selection reasoning, not statistical
  modeling — could be tackled independently and sooner. Not started.
  (2026-09-14: gold's live price is now tracked via `get_context_indicators`'
  `gold_price` field — purely tracking, doesn't touch or examine the
  sleeve-weight question itself, which remains exactly as open as before.)

- **Crash-probability presentation: numeric % vs. categorical.** An
  external review suggested replacing the percentage entirely with
  categorical language ("Qualitative risk assessment: Elevated," "Evidence
  balance: 2 confirmed core stress indicators, 1 pending, credit not yet
  confirming") until a real calibrated model exists, rather than keeping
  the % with a caveat next to it (the current approach). Legitimate
  alternative, not obviously right or wrong — needs a deliberate decision,
  not a default.

- **Dashboard hierarchy reorganization — partially addressed 2026-09-15.**
  The full 4-layer structure (Current state / What changed / Why it
  matters / Decision policy) is still unbuilt, but the specific pain this
  was flagging — a long single scroll, worse once the sector-rotation
  card added real height — got a cheap partial fix: 6-Indicator History's
  trend charts now collapse by default (state remembered per-viewer via
  localStorage), since that's review/verification detail, not
  current-state info. The bigger structural reorg remains open.

## The hazard-model / regime-detection work (the big one)

~~The single largest deferred item~~ — **v1 built and live 2026-08-26**: a
logistic-regression hazard model, `P(S&P drawdown reaches >=10% from ATH
within ~21 trading days | not already past it)`. Walk-forward validated
(expanding window, leave-one-crisis-out across dot-com/GFC/Dec-2018/COVID/
2022), found miscalibrated, fixed with isotonic regression (stratified
5-fold on pooled out-of-sample predictions), and confirmed via episode-level
block-bootstrap CI to have a real edge over a naive base-rate guess for this
target specifically. Hand-ported to TypeScript (`rule_engine/src/hazardModel.ts`,
no live Python dependency — the architectural fork below is now resolved),
computed daily alongside the 6-indicator panel, surfaced via
`get_indicator_panel`'s `hazard_model_10pct` field and a dedicated dashboard
card — deliberately non-gating and never blended with `crash_probability_pct`.
Backtesting this against the *existing* rule engine first (Phase 0, per the
tooling menu's own "highest priority" framing below) turned out to be
genuinely valuable groundwork: it surfaced real gaps (Wave 3 essentially
never fires outside GFC-style panics; the 3-of-6 gate can lag a real crisis
by months) that fed directly into the model's design, and confirmed the
existing wave logic has strong precision even where its timing is weak.

**Still genuinely open, now with more specific shape than before:**

- **A companion 20%-drawdown target was tested and explicitly shelved** —
  its bootstrap CI spanned zero (only 4 usable real episodes for that
  deeper threshold), so it couldn't be distinguished from a naive guess.
  Not shipped in any form. Revisit only if more real crises accumulate.
- **Point-in-time data gap — partially scoped 2026-09-15, not fixed.** The
  model trains/runs on latest-revised FRED values, not the real-time
  vintage that would actually have been knowable historically. Correction
  to the earlier framing here: this does **not** need a separate ALFRED
  API — FRED's standard `series/observations` endpoint already supports
  `realtime_start`/`realtime_end`/`vintage_dates` (confirmed against
  FRED's own API docs). `RECPROUSM156N` specifically is now a **confirmed**
  case, not just a theoretical risk — its producer's own FAQ states
  smoothed historical values are revised using subsequently-available data
  (jeremypiger.com/recession_probs_faq), plus a real Dec 2020 methodology
  change for COVID. The model's `RECPROUSM156N` coefficient was fit on
  hindsight-contaminated data. **Not patched by editing the model
  artifact** — see crash-check-rules.md's hazard-model section for why
  that would introduce a different, uncontrolled distortion rather than
  remove the contamination. Real fix needs retraining with vintage-aware
  data (or the feature dropped), which needs the original training
  pipeline — not preserved anywhere in this repo (it lived only in an
  earlier session's scratchpad). A real, scoped research task, not a code
  fix.
- **Calendar-day vs. trading-day delta approximation — fixed 2026-09-15.**
  Production now uses exact trading-day anchors (`getTradingDayAnchor()`,
  counting back rows in `SP500` as the market-calendar reference) instead
  of the old 7/28-calendar-day approximation. Verified live: the old
  approximation's "7 days back" landed on Labor Day (not a real trading
  day) in a real live check.
- **Broader hazard-model validation review (external, 2026-09-15) — not
  yet acted on, needs scoping.** A rigorous outside review raised several
  questions that can't be answered from what's preserved in this repo
  (the original training pipeline is gone) — would need genuinely redoing
  the research, not auditing it: (1) whether the model beats a naive
  "current drawdown alone" baseline, given the target's proximity to the
  threshold is itself informative near a 7-10% drawdown; (2) whether
  leave-one-crisis-out training ever included crises chronologically
  *after* the held-out one (a legitimate transfer-learning test, but not
  a real walk-forward reproduction of "what could have been forecast
  then"); (3) exact label/episode-eligibility definitions (closing vs.
  intraday breach, re-entry after partial recovery). Also flagged:
  stratified 5-fold isotonic calibration on pooled predictions can mix
  temporally-adjacent observations across folds — worth comparing against
  a simpler regularized logistic (Platt-style) recalibration under a
  genuinely chronological split. Secondary ideas (not urgent): a
  volatility/GARCH-based threshold-crossing challenger model, new
  candidate features (VXVCLS, VIX9D/VVIX, Fed excess bond premium, OFR
  stress index components), richer reported metrics (Brier score, log
  loss, false-alarm episodes/year, warning lead time). Explicitly agreed
  with the review's recommendation to keep COT/Z.1/sector-rotation out of
  this model — informational-tier signals, not validated inputs.
- **Crash-probability presentation: numeric % vs. categorical** — this
  question (previously an abstract external-review suggestion) now has
  real evidence behind one side of it: the hazard model's own isotonic
  calibration curve is steppy with two wide flat plateaus, so its output is
  *already* shown banded (LOW/TRANSITIONING/HIGH) rather than as a raw %,
  for exactly the categorical-over-precision reasoning the earlier review
  proposed. Whether `crash_probability_pct` (still 100% LLM judgment)
  should eventually get the same treatment is still an open, undecided
  question — the hazard model didn't replace it, just sits alongside it.
- **Wave 2/3 threshold calibration** — still open, but no longer just a
  hunch: the Phase 0 backtest gave concrete numbers (Wave 3 fired in only
  1 of 5 real episodes, missing the single worst crash in the dataset
  because VIX-and-drawdown-jointly doesn't fit a slow grinding bear). A
  real, evidence-backed target for recalibration, not yet acted on.
- **Deployment-outcome backtesting is still SPY-proxy only** — tested
  whether wave *timing* beats DCA/all-at-once (it does, clearly), but not
  against the actual defensive fund mix (Healthcare/REIT/Intl/TIPS/Energy/
  Gold) — no free historical data for those funds has been pulled yet.
- **Tooling menu items not used in v1** (`vectorbt`, `sktime`, `hmmlearn`,
  Merlion/Kats, Chronos) — the actual build used plain `scikit-learn`
  (`LogisticRegression` + `IsotonicRegression`), simpler than the original
  menu assumed. Worth revisiting only if a future iteration needs proper
  regime-detection (`hmmlearn`) or more rigorous walk-forward tooling
  (`sktime`) than the hand-rolled expanding-window loop used here.
- **A 3rd recession-probability model (Cleveland Fed's yield-curve model)**
  — still an open tension, unresolved: adding more competing probability
  cross-checks risks exactly the overfitting the rules doc already warns
  about when the 2nd model was added.

## Process & content

- **Reassess shipped work after a stretch of usage — recurring practice,
  next one not yet due.** Done 2026-09-12 against 126 real `crash_checks`
  rows (July 9 – Sep 11): confirmed the hazard model, divergence detection,
  delta log, and daily/scheduled run cadence are all behaving correctly in
  practice, and surfaced one real gap invisible at build time — `trigger_status`
  never retired stale entries (fixed same day, commit `61e12f2`). Worth
  repeating after the next meaningful batch of shipped work has had a real
  stretch of daily runs behind it — this is exactly the kind of thing that
  only shows up in production data, not a build-time check.

- **BrokerageLink watchlist ticker selection has no documented rationale.**
  The 7 tickers each have a one-line theme tag but no written reasoning for
  why that specific name over an alternative in the same theme. The
  Portfolio Opportunity Review process is the mechanism to close this gap
  — so far it's only re-examined price targets, not the underlying ticker
  choices themselves.

- **Idea, discuss later: package this as a Kubernetes / plug-and-play open
  source solution**, rather than this user's personal deployment. Not
  analyzed — flagged only. The split-storage security model assumes a
  single local user, not multi-tenant; the rules doc's specific
  thresholds/percentages/watchlist are this user's own calibration and
  would need to become configurable; unclear whether Kubernetes is even the
  right packaging target given the current stack is serverless/edge-native
  with no long-running compute.
