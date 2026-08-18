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

- ~~30yr Treasury yield (`DGS30`)~~ — **built.** Had been ingested since
  this system's first setup but never surfaced. Wired into
  `get_context_indicators` and `dashboard_site` using the rules doc's
  existing "above 5.0% = bond vigilante signal" threshold.

- ~~Recent-grad unemployment indicator (`CGBD2024`)~~ — **built and live.**
  Wired into the NVDA "AI recovery trough bet" thesis re-underwrite step.

- ~~Wave deployment authorization, relative drawdown thresholds, cumulative
  execution-aware deployment~~ — **built 2026-08-15.** `get_deployment_plan`
  now requires both `wave_active` and `wave_authorized` (previously only
  checked the former); wave triggers switched from fixed S&P levels
  (6,200/5,600/4,800 — confirmed decaying, Wave 1's level had drifted from
  ~-17% to ~-18.1% below ATH since being set) to ATH-relative drawdown %
  (16/24/35), which doesn't decay; deployment is cumulative across waves
  with local execution-state tracking (`wave_deployment_state.yaml`,
  `record_wave_deployment`).

- **Wave 2/3 threshold calibration — still genuinely open.** The relative-
  drawdown fix above only fixed the *decay* problem, not whether 16/24/35%
  + VIX 28/35/45 are the *right* bars. Backtested against real 2016–2026
  history: Wave 3 never fired in 2020 despite VIX peaking at 82 (drawdown
  missed the 35% bar by ~1pt); Wave 2 never fired in 2022 despite a real
  24%+ drawdown, because VIX never sustained above 35 in that "grinding"
  bear market. An external review independently proposed VIX-as-accelerator
  rather than a hard gate — this needs the same real-backtest treatment as
  everything else here, not a quick sign-off. Belongs with the hazard-model
  work below, not a standalone tweak.

- ~~Cross-indicator divergence detection — reverse HY-vs-VIX direction~~ —
  **built 2026-08-16** (`hy_widening_vix_calm`, the more concerning "credit
  moves first" direction, previously missing). **Still open**: rolling-
  correlation infrastructure, and a regime-dependent 10yr-vs-equities pair
  (its intended meaning genuinely differs by macro regime, so it needs the
  regime concept from the hazard-model work below to mean anything).

- ~~Recovery-transition detection (Stage 4)~~ — **detection built
  2026-08-16** (trough tracking, VIX-sustained-25-for-3-weeks, the 3-
  criteria composite gate). **Still open**: the month-by-month execution
  tracking (which glide-path step you're actually on) — no equivalent of
  `wave_deployment_state.yaml`/`record_wave_deployment` exists for this yet.

- ~~Rate-reset trigger reliability~~ — **built 2026-08-17, took 3 attempts.**
  Two rounds of prose instructions asking the LLM to compare dates itself
  both failed live (wrong field compared, then an accurate note paired with
  a stale status anyway). Made fully deterministic: `write_snapshot` now
  forcibly overwrites this one trigger's status/note server-side, matched
  by name — no code path left where the LLM's interpretation matters. Worth
  remembering as a pattern: prose instructions for anything with one
  objectively correct answer are the wrong tool, even when very explicit.

- **Market-internals / breadth proxy via relative ETF performance.**
  Raw breadth data (% of S&P above 200dma, advance/decline line) has no
  free source — confirmed. But relative price performance between publicly
  tradeable tickers does the same job without needing raw breadth stats:
  equal-weight vs. cap-weight S&P (RSP vs SPY), Russell 2000 vs S&P (IWM vs
  SPY), bank-sector ETF vs S&P (KBE/KRE vs SPY) — all buildable via the
  Massive ticker-price pulls already wired in. Genuinely new idea (surfaced
  2026-08-17 via external review), not previously explored. Not started.

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

Still the single largest deferred item — a two-layer hazard-probability
model + regime detection + expected-utility deployment policy, replacing
the "3 of 6 RED" gate and giving the LLM-judged crash probability an actual
calibration standard (event/horizon definitions, expanding-window OOS
testing, reliability curves, Brier score, block-bootstrap CIs). Deliberately
scoped as its own dedicated planning session, not attempted piecemeal.
Reference material gathered so far, not yet acted on:

- **Tooling menu** (external review, 2026-08-17): `vectorbt` (backtesting
  the current 3-of-6/confirmation/wave rules against real history — the
  "highest priority" per that review, and it's right that this is more
  urgent than any new model), `sktime` (walk-forward validation, model
  comparison), `hmmlearn` (a small 4-5 state Gaussian HMM for regime
  probabilities — lighter-weight starting point than a full Bayesian
  dynamic factor model), Merlion and Kats (multivariate anomaly detection —
  both real but both research-lab releases with slowed maintenance; verify
  current activity before depending on either), Chronos (Amazon's
  pretrained time-series models — correctly scoped as an anomaly/forecast-
  range feature only, never a direct price-forecast-to-allocation path).
- **A real architectural fork that needs deciding at that session, not
  assumed**: a one-time offline Python research script whose fitted
  coefficients get ported into TS (the original decision, no live Python
  dependency in production) vs. an ongoing scheduled Python service
  producing versioned advisory outputs consumed by the TS system (a
  meaningfully bigger operational commitment — new runtime, scheduling,
  hosting, monitoring). The tooling menu above assumes the second without
  flagging that it's a different choice than what was originally decided.
- **A 3rd recession-probability model (Cleveland Fed's yield-curve model)**
  was suggested as an additional cross-check alongside the two already
  added (Chauvet-Piger, NY Fed Estrella-Mishkin). Tension worth resolving
  deliberately: when the 2nd model was added, the rules doc itself noted
  "adding more variables tends to overfit out-of-sample, worth remembering
  before adding a 3rd/4th competing probability model here."
- Also see "Wave 2/3 threshold calibration" and "Crash-probability
  presentation" above — both belong with this work, not as standalone
  fixes.

## Process & content

- **Reassess recent shipped work after a real stretch of usage —
  significantly overdue.** Originally set for ~2026-07-18; a large amount
  has landed since, including the entire 2026-08-15/16/17 batch (wave
  deployment fixes, honest relabeling, divergence expansion, recovery
  detection, the rate-reset trigger saga, two new indicators). Each piece
  validated once at build/verification time, not yet observed over a real
  stretch of repeated daily runs in practice.

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
