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
  UI in v1. Verified end-to-end 2026-07-14 (Access login → Pages Function →
  Supabase query all confirmed working) — see project memory for the
  deploy/Access gotchas hit along the way. Not covered: Access policy
  coverage of Cloudflare Pages preview-deployment URLs — low priority for
  a single-user page.

  **Update 2026-07-16 — Portfolio Opportunity Review merged in too, live and
  verified.** The earlier "`portfolio-review-template.html` is permanently
  chat-only, never published" exclusion was explicitly reversed by the
  user. New `portfolio_review_snapshots` table (same deny-all RLS pattern,
  migration applied and anon-permission-denied re-verified) +
  `write_portfolio_review` MCP tool (drift recomputed server-side, every
  free-text field guardrail-checked) + a new page section (verdict, drift
  bars, ticker thesis cards merged with live watchlist status, macro
  cross-reference, and a server-side-rendered risk radar chart replicating
  the template's hexagon SVG math). Position-sizing dollar figures
  (`max_position_usd`) still never persisted — everything else now does.
  Ran a real Portfolio Opportunity Review and confirmed every new section
  renders correctly via a PDF export of the live page. Found and fixed one
  real bug from that test: `full_report_snapshots.watchlist` only refreshed
  on `write_full_report` calls, so a target change from `write_watchlist`
  during this Portfolio Review (CCJ's Wave 1 target, $44→$70) sat stale in
  the watchlist table, directly contradicting the Portfolio Review
  section's own narrative right below it. `write_watchlist` now also
  patches the latest `full_report_snapshots` row's watchlist immediately.

  A second bug surfaced from the same test: the "Portfolio Drift" section
  showed only standing flags, no actual allocation bars — `computePortfolioDrift()`
  treated "has `dry_powder_usd`" and "has a full target breakdown" as
  mutually exclusive, so `tactical_401k` (which has both) had its
  legitimate fund-level drift silently suppressed entirely. Fixed (commit
  049b5c4) per explicit user preference for full visibility: the
  wave-gated standing flag now appears *alongside* full fund-level entries,
  not instead of them — verified against the real portfolio file (all 7
  funds now show, including the dry-powder fund's own large, intentional
  deviation). Also improves `get_portfolio_drift` directly, not just this
  page.

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

- ~~Trigger notifications on threshold crossings~~ — **built**. A free
  ntfy.sh push notification (`rule_engine/src/lib/notify.ts`) fires the
  moment `confirmed_red_count` crosses up into 2+, comparing against the
  prior `crash_checks` row so it only fires on the transition, not every
  day the condition holds — runs inside the existing 10am ET `classify`
  job, no new schedule needed. Topic name is the `NTFY_TOPIC` GitHub
  secret. Delivery mechanism verified via a manual test push (confirmed
  received on phone); the actual threshold-crossing code path hasn't been
  exercised by a real transition yet (rare by design).

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
  probability estimate or a garbled diagnosis.

  A related risk surfaced when checking whether 7am ingestion + 7:30am
  Claude was a safe pairing: `ingest.yml`'s actual run history shows
  GitHub's cron trigger has been delayed **up to 62 minutes** past its
  nominal 7am ET schedule — a fixed-offset scheduled Claude run could
  silently analyze yesterday's stale `crash_checks` row with no warning.
  **Fixed**: a new `data_freshness` check (`mcp_server/src/lib/
  freshness.ts`, commit 635b82d) compares the latest row's date against
  the expected ingestion date (accounting for weekends) and now makes step
  1 of the workflow stop and report staleness instead of proceeding —
  covers both manual and the unattended 2pm run. Also moved ingestion from
  7am to **10am ET** (commit 7dcf430) for extra buffer (~4hrs before the
  2pm run) — not strictly necessary given the freshness check, but cheap
  insurance against a wasted/skipped run on an unusually-late ingestion day.
  Final daily pipeline: **ingestion 10am ET → Claude analysis 2pm ET**.

  **Not yet confirmed:** whether 2pm actually avoids the original skip
  issue, whether the writes landing in `crash_checks`/`full_report_snapshots`
  look correct, or whether the freshness check itself has actually
  triggered/behaved correctly on a real stale-data day — check back after
  a couple days of real runs.

- ~~PWA / phone-friendly reporting site(s)~~ — **built**, both sites.
  `manifest.json` + generated icons (shared pulse/sparkline glyph, blue
  accent for `dashboard_site`, red accent for `full_report_site`) +
  `apple-touch-icon`/`theme-color` tags. Deliberately manifest-only, no
  service worker — avoids caching `full_report_site`'s Access-gated content
  in a way that could outlive a logged-out session, or showing stale
  financial data while offline. **Not yet verified live:** needs a push and
  a real "Add to Home Screen" test on a phone.
