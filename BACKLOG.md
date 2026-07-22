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

- **`write_full_report`'s schema fix not yet confirmed with a live retry.**
  The tool was completely broken (nullable-object schema rejected
  `crash_type_diagnosis` no matter what was sent) — fixed and type-checked
  (commit 0dd5a3e), but no successful `write_full_report` call has actually
  happened since. Needs a Claude Desktop restart to pick up the change,
  then a retry (manual or the next crash check) to confirm it actually
  works end to end now.

## Data & infrastructure

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

- **Idea, discuss later: cross-indicator divergence detection.** The rule
  engine classifies indicators individually (VIX band, HY band, etc.) but
  never looks at relationships between them — so a real signal like
  "credit spreads aren't confirming an equity wobble" only ever surfaces
  informally, in the LLM's narrative, run to run. Surfaced 2026-07-18 via
  another periodic external review; deliberately held pending the
  reassess-after-a-week checkpoint above. Cheapest starting point when
  picked up: IG-vs-HY and initial-vs-continuing-claims divergence (both
  already-ingested series, just a subtraction + a calibrated threshold).
  Full write-up, including where the review's proposal needed pushback
  (data-depth, a vague "meaningfully" qualifier, skepticism on the
  regime-dependent 10yr-vs-equities pair specifically), in project memory
  (`backlog_cross_indicator_divergence_detection.md`).

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

- **Reassess recent shipped work after a week of real usage** (~2026-07-18
  checkpoint). A lot landed in a short window — Portfolio Opportunity
  Review merged into the Full Report page, the switch to Massive for
  ticker prices, historical backfills, the Signal Tiering
  confirmation-window rule, the delta-lookback tool, new context
  indicators — each validated once, not yet observed over repeated real
  runs. Also folds in: whether `dashboard_site` and the chat-report
  templates should stay as different as they currently are.

- **BrokerageLink watchlist ticker selection has no documented rationale.**
  The 7 tickers each have a one-line theme tag but no written reasoning for
  why that specific name over an alternative in the same theme. The
  Portfolio Opportunity Review process is the mechanism to close this gap
  — so far it's only re-examined price *targets* (CCJ's, most recently),
  not whether the underlying ticker choices themselves still hold up.

- **Daily automation reliability — not yet confirmed.** Pipeline is built
  (ingestion 10am ET → Claude Desktop scheduled "run crash check" 2pm ET,
  freshness-checked) but two things remain unverified: whether the 2pm
  scheduled task actually fires reliably (a real stall was observed once,
  waiting on an approval question that never got answered — unattended
  runs have no one to answer it), and whether the data-freshness guardrail
  has ever actually triggered/behaved correctly on a real stale-data day.
  Check back after a few more days of real runs.
