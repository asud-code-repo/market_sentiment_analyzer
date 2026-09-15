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

- **Per-series data-quality/freshness metadata.** The whole-run freshness
  check exists; nothing per-series. A "green" panel could still be built
  from a mix of today's VIX, last week's claims, and a silently-stale
  monthly series. Concrete field list proposed: latest observation date,
  source publication timestamp, expected cadence, days since latest valid
  observation, last successful ingestion time, data-quality state
  (current/expected-lag/stale/failed/quarantined). Not started.

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

- **Dashboard hierarchy reorganization** — a suggested 4-layer top-level
  structure (Current state / What changed / Why it matters / Decision
  policy) instead of the current single scroll. UX idea, moderate value,
  lower urgency than the substantive gaps above.

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
- **Point-in-time data gap** — the model trains/runs on latest-revised FRED
  values, not the real-time vintage that would actually have been knowable
  historically (CPI/unemployment/retail sales get revised after initial
  release). Known limitation, not fixed. Would need FRED's separate ALFRED
  vintage API.
- **Calendar-day vs. trading-day delta approximation** — production uses
  7/28 calendar days for the model's velocity features instead of the
  research's exact 5/20 trading days, to match this system's own existing
  delta convention. Flagged, not expected to matter much  in practice, never
  independently verified against the trading-day version live.
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
