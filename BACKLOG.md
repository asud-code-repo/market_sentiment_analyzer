# Backlog

Things deliberately deferred, not forgotten. Grouped by area, not priority.

## Security & access

- ~~Cloudflare Access lockdown on `dashboard_site`~~ — **resolved as a
  deliberate decision, not deferred.** The data is safe by design
  (RLS-scoped anon key, macro-only tables), and the user wants to be able
  to share this page with others — a single-email Access policy works
  against that goal. Decided: leave it public. Cloudflare Access is
  reserved specifically for the confidential Full Report page below, where
  restricting access to just the user *is* the point.

- ~~"Full Report" Cloudflare Pages project~~ — **live**, at
  `market-sentiment-full-report.pages.dev`. Distinct from the existing
  public `dashboard_site` (unchanged). Shows the brokerage watchlist
  (tickers + wave price targets), the crash-type diagnosis narrative, and
  the *qualitative* parts of the personal portfolio snapshot — all
  previously chat-only. Cloudflare Access (One-Time-PIN login, gmail-gated)
  + a **Cloudflare Pages Function** (`full_report_site/functions/index.ts`)
  doing server-side Supabase queries with the `service_role` key, never
  exposed to the browser. Data lives in a separate Supabase table
  (`full_report_snapshots`, RLS deny-all for anon/authenticated). Layout:
  **Option B "Bridge"** (4-stat context strip + crash-type diagnosis +
  dense single-line watchlist). History writes from day one, no browsing
  UI in v1. Explicitly **out of scope, permanently**:
  `portfolio-review-template.html`. Verified end-to-end 2026-07-14 (Access
  login → Pages Function → Supabase query all confirmed working) — see
  project memory for the deploy/Access gotchas hit along the way. Currently
  shows the empty state since `write_full_report` hasn't run against real
  content yet. Not covered: Access policy coverage of Cloudflare Pages
  preview-deployment URLs — low priority for a single-user page.

- ~~No code-level guard against personal dollar figures leaking into
  Supabase~~ — **implemented, both write paths.** `write_snapshot`'s `notes`
  field and the new `write_full_report`'s `portfolio_context`/
  `crash_type_diagnosis` fields both cross-reference real dollar figures
  from `local_state/portfolio.yaml` (`_usd`/`_cad` keys, ≥$1,000) against
  incoming text (raw and comma-formatted, with substring-boundary
  protection) and throw before persisting if a match is found, rather than
  relying on prompt instruction alone. Explicitly rejected as an
  alternative: reducing `local_state/portfolio.yaml`'s own precision — that
  file needs to stay exact for `get_deployment_plan`/`get_portfolio_drift`
  to keep working.

## Data & infrastructure

- **Delta-standard (3-day/7-day Δ) can't actually be computed yet.** The
  rules doc requires every indicator/ticker to show a 3-day and 7-day
  delta, but no MCP tool exposes historical "N-days-ago" lookback values —
  they only return the latest reading. The underlying history already
  exists in `data_points` (5yr FRED backfill, 2yr ticker backfill); this
  needs a new tool/extension to actually surface it. Verified live: Claude
  correctly declined to fabricate these numbers rather than making them up,
  so the gap is graceful, not silently wrong — just unfulfilled.

- **Wave 2/3 threshold backtest finding.** Backtested the wave-authorization
  thresholds against real 2016–2026 history: Wave 3 (drawdown≥35% &
  VIX>45) never fired in 2020 despite VIX peaking at 82 — the drawdown side
  missed the 35% bar by about a point. Wave 2 (drawdown≥24% & VIX>35) never
  fired at all in 2022, despite a real 24%+ drawdown that year, because VIX
  never sustained above 35 in that "grinding" bear market. Worth a second
  look at whether the joint drawdown-AND-VIX construction is calibrated
  right — not acted on yet, just flagged so it isn't lost.

## Process & content

- **Reassess recent shipped work after a week of real usage.** A lot
  landed in a short window (Portfolio Opportunity Review template, the
  switch to Massive for ticker prices, the historical backfills, the
  Signal Tiering confirmation-window rule) — each validated once, not yet
  observed over repeated real runs. Also folds in: whether
  `dashboard_site` and the two chat-report templates should stay as
  different as they currently are, once there's been time to live with the
  split.

- **BrokerageLink watchlist ticker selection has no documented rationale.**
  The 7 tickers each have a one-line theme tag (e.g. "energy/stagflation,"
  "uranium/AI power") but no written reasoning for why that specific name
  over an alternative in the same theme. The Portfolio Opportunity Review
  process is the mechanism to close this gap — so far it's only
  re-examined price *targets* (flagging one as likely stale), not whether
  the underlying ticker choices themselves still hold up.

- **Automating the full daily analysis — in testing.** The daily GitHub
  Action still only runs deterministic classification; the full qualitative
  synthesis (crash probability, narrative, crash-type diagnosis) used to
  only happen when a chat session was manually triggered. As of 2026-07-14,
  the user has a **Claude Desktop native scheduled task** running "run
  crash check" daily at **2pm** (chosen as non-peak, to dodge the earlier
  unexplained peak-hours skip) — no GitHub Action, no direct API billing,
  just the existing Desktop subscription running the same workflow a human
  would. This means `write_snapshot` and `write_full_report` now persist
  unattended, with no human review before writing — the dollar-figure
  guardrail still catches that one specific failure mode, but not a bad
  probability estimate or a garbled diagnosis. **Not yet confirmed:**
  whether 2pm actually avoids the skip issue, or whether the writes
  landing in `crash_checks`/`full_report_snapshots` look correct — check
  back after a couple days of real runs.

- **PWA / phone-friendly reporting site(s).** Worth exploring making the
  reporting surface(s) installable to a phone home screen — a manifest
  file, optionally a service worker for offline caching. The existing
  responsive breakpoints already give this a real foundation. Best picked
  up once the new Full Report page above actually exists, so it's clear
  which surface is worth making installable first.
