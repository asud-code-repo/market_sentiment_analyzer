# Backlog

Things deliberately deferred, not forgotten. Grouped by area, not priority.

## Security & access

- **Cloudflare Access lockdown.** `dashboard_site` is live on Cloudflare
  Pages but publicly unauthenticated — anyone with the link can view it.
  The data itself is safe by design (RLS-scoped anon key, macro-only
  tables), but there's no reason to leave it open. Plan: Zero Trust →
  Access → Applications → self-hosted app scoped to the `.pages.dev`
  domain, policy restricted to a single email via OTP.

- **Unify the crash-check report with the public dashboard site.** The
  chat-rendered report (`dashboard-template.html`) shows a brokerage
  watchlist (tickers + wave price targets) and a crash-type diagnosis
  narrative that the public site doesn't. A full plan exists for moving
  these over, but it requires real auth first — **Cloudflare Access alone
  isn't sufficient**, since it only gates page *loading*, not direct
  requests to Supabase's REST API (a separate origin). The recommended
  design is two-tier: Cloudflare Access (page-level) + Supabase Auth with
  RLS scoped to an authenticated session (data-level), with the watchlist
  specifically requiring the stronger tier. Explicitly **not** in scope for
  this: `portfolio-review-template.html`, which stays chat-only,
  permanently, regardless of what auth gets built for the crash-check side.

- **`write_snapshot` has no code-level guard against personal data leaking
  into Supabase.** Every other security boundary in this project (RLS,
  GRANTs, `.gitignore`, the local-only MCP server) is enforced at an
  infrastructure or code level. The one exception: the `notes` field
  persisted by `write_snapshot` relies entirely on a prompt instruction not
  to include personal dollar figures. Proposed fix: have `write_snapshot`
  cross-reference the real portfolio figures (readable locally) against the
  incoming text and reject the write if a match is found, rather than
  trusting instruction-following alone.

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

- **Explore automating the full daily analysis.** Right now, the daily
  automated job only runs deterministic classification — the full
  qualitative synthesis (crash probability, narrative, crash-type
  diagnosis) only happens when a chat session is manually triggered.
  Automating that fully is a real option, but changes the trust model (no
  human review before persisting) and has a genuine per-run API cost to
  weigh against the current zero-marginal-cost manual trigger.
