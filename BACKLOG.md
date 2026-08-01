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

- ~~30yr Treasury yield (`DGS30`)~~ — **built, and immediately relevant.**
  Had been ingested since this system's very first setup but never
  surfaced anywhere — found while checking for other already-documented-
  but-unwired rules doc bands. `crash-check-rules.md` already defines its
  threshold ("above 5.0% = bond vigilante signal"); wired into
  `get_context_indicators` and `dashboard_site` using that existing
  threshold. Verified live: **current reading is 5.21%, already above the
  threshold** — real signal that had zero visibility until now. Worth
  checking whether other rules-doc-documented bands (Shiller CAPE, CME
  FedWatch rate-hike probability, both also listed under "Additional
  bond-market bands") have a similar gap — those two aren't currently
  ingested at all though, so they'd need real new sourcing work, not just
  wiring.

- ~~Recent-grad unemployment indicator (`CGBD2024`)~~ — **built and live.**
  Added as Tier 2/3 context (FRED's BLS/CPS proxy for the NY Fed's own
  "recent college grad" research, which isn't itself on FRED), specifically
  wired into the NVDA "AI recovery trough bet" thesis re-underwrite step.
  Regular daily ingestion already picked up its first live reading without
  needing a backfill (ingestion always fetches each series' latest point
  regardless of backfill status) — a backfill run is still worth doing for
  historical *depth* (deltas, future trend charts), just not required for
  the indicator to show a current value. Also surfaced and fixed a real bug
  while verifying this on the live dashboard: `dashboard_site`'s Contextual
  Indicators grid used one combined query across all context series, which
  silently dropped low-frequency series (`DRCCLACBS`, `DRTSCILM`) once
  enough daily series existed to crowd them out of the shared row limit —
  not missing data, a fetch-logic bug. Fixed (one query per series, same
  pattern `mcp_server` already used correctly) and verified live.

- **Wave 2/3 threshold backtest finding.** Backtested the wave-authorization
  thresholds against real 2016–2026 history: Wave 3 (drawdown≥35% &
  VIX>45) never fired in 2020 despite VIX peaking at 82 — the drawdown side
  missed the 35% bar by about a point. Wave 2 (drawdown≥24% & VIX>35) never
  fired at all in 2022, despite a real 24%+ drawdown that year, because VIX
  never sustained above 35 in that "grinding" bear market. An external
  methodology review (2026-07-16) independently proposed a specific fix —
  VIX as an *accelerator* rather than a hard gate — but this needs a
  dedicated discussion before any change, not a quick sign-off (see below).

- **External methodology review, 2026-07-16 — Buckets 2 & 3 still open.**
  A separate model reviewed the full architecture + rules doc (see
  `reference_docs/architecture-summary-for-external-review.md`); findings
  were verified against actual code before accepting. Bucket 1 (code-only:
  delta-lookback tool, 2 new FRED series, ingestion plausibility guard) is
  done. Remaining:
  - **Bucket 2 (rules-doc changes, needs one v6 redline sign-off session)**:
    wave triggers restated in drawdown % instead of absolute S&P levels
    (confirmed real decay — Wave 1's "$6,200" was ~-17% from ATH when
    written, now ~-18.1% and drifting as new ATHs land); a defined
    event/horizon for the crash-probability % (currently unfalsifiable —
    "13%" of *what*, by *when*); the breadth-band dead-code decision (wire
    a source or delete it — no ingestion source exists for "% of stocks
    above 200dma"); stale "checks run 6-7x/day" language cleanup.
  - **Bucket 3 (deployment-logic redesign, dedicated discussion)**: VIX as
    accelerator not gate (see Wave 2/3 finding above); Fed pivot signal
    conditioning (cut + weak labor = RED, cut + clean labor = AMBER,
    avoiding a phantom RED from a benign easing cycle); 10yr rate-of-change
    overlay (level band confirmed stuck AMBER ~4.5-4.6% for this system's
    entire life — genuinely uninformative); Warsh MODERATE/DOVISH
    mechanical criteria (closing the gap the rules doc has deliberately
    left open pending user sign-off).

- ~~Cross-indicator divergence detection~~ — **3 pairs built.**
  `mcp_server/src/lib/divergence.ts` computes IG-vs-HY,
  initial-vs-continuing-claims, and VIX-vs-HY divergence deterministically
  (reusing `get_series_deltas`), wired into `get_context_indicators` as
  `divergence_flags` — replaces the old approach of handing the model raw
  numbers and a hint to compare itself. Verified live (all currently
  `false`). Thresholds are a first cut, not backtested. Note: VIX-vs-HY's
  `diverging: true` is the *reassuring* case (equity-specific noise, not
  systemic stress) — opposite of the other two pairs, documented
  explicitly so it isn't misread. **Still open**: rolling-correlation
  infrastructure, the regime-dependent 10yr-vs-equities pair, and the
  reverse HY-vs-VIX direction (HY widening without VIX confirming —
  arguably the more concerning direction, since credit often leads
  equity) — deliberately deferred, see project memory
  (`backlog_cross_indicator_divergence_detection.md`).

- ~~Portfolio drift methodology — the 5/25 rule~~ — **built.**
  `computePortfolioDrift()` now uses a per-fund threshold (min(5pp
  absolute, 25% of that fund's own target), floored at 2pp) instead of one
  flat 5pp number — verified against real targets before committing,
  output matches the hand-computed table exactly. **Still open, three
  bigger scope items** from the same review: splitting `get_portfolio_drift`
  into structural/tactical response fields (mostly cosmetic — the
  underlying logic already separates them), an age-based glide-path target
  for the spouse 401k (moot for now — no target is currently set for that
  account at all), and an effective-number-of-bets diversification metric
  for the watchlist (real technique, but the review's "concentrated"
  example cherry-picked 5 of 7 actual tickers — unconfirmed whether the
  real watchlist needs this). `riskfolio-lib` flagged as a free Python
  option if this gets built. Full write-up in project memory
  (`backlog_portfolio_drift_methodology_review.md`).

- **Idea, discuss later: package this as a Kubernetes / plug-and-play open
  source solution**, rather than this user's personal deployment (2x
  Cloudflare Pages, Supabase, GitHub Actions cron, a local stdio MCP server
  tied to this user's own `local_state/` files and Claude Desktop config).
  Not analyzed yet — flagged only. Worth weighing when it comes up: the
  split-storage security model assumes a single local user, not
  multi-tenant; the rules doc's specific thresholds/percentages/watchlist
  are this user's own calibration and would need to become configurable;
  and whether Kubernetes is even the right packaging target given the
  current stack is already serverless/edge-native with no long-running
  compute.

## Process & content

- **Reassess recent shipped work after a week of real usage — overdue.**
  Originally set for a ~2026-07-18 checkpoint; it's now 2026-08-01, two
  weeks past it, with even more landed since (the 5/25 rebalancing rule,
  three divergence-detection pairs, the recent-grad unemployment
  indicator, two real bugs found and fixed in the daily scheduled task,
  a dashboard fetch-logic bug) on top of the original list — Portfolio
  Opportunity Review merged into the Full Report page, the switch to
  Massive for ticker prices, historical backfills, the Signal Tiering
  confirmation-window rule. Each validated once at build time, not yet
  observed over a real stretch of repeated daily runs. Also folds in:
  whether `dashboard_site` and the chat-report templates should stay as
  different as they currently are.

- **BrokerageLink watchlist ticker selection has no documented rationale.**
  The 7 tickers each have a one-line theme tag but no written reasoning for
  why that specific name over an alternative in the same theme. The
  Portfolio Opportunity Review process is the mechanism to close this gap
  — so far it's only re-examined price *targets* (CCJ's, most recently),
  not whether the underlying ticker choices themselves still hold up.

