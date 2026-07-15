# Full Report site

Private companion to the public `dashboard_site` — shows the BrokerageLink
watchlist, crash-type diagnosis, and qualitative-only personal portfolio
context. Served by a Cloudflare Pages Function (`functions/index.ts`) that
queries Supabase server-side with the `service_role` key, so there is no
client-side credential for this content to leak. Gated by Cloudflare Access.

## One-time Cloudflare setup

1. **New Pages project**, separate from `dashboard_site` — connect the same
   GitHub repo, set **Root directory** to `full_report_site`. Build command
   and output directory can stay empty/default (no static build step; the
   Function is picked up automatically from `functions/`).
2. **Environment variables** (Settings → Environment variables, mark as
   *secret*, not plaintext):
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY` — the same service role key `mcp_server`
     uses locally. Never put this in `wrangler.toml` or any committed file.
3. **Cloudflare Access**: create an Access Application for this Pages
   project's domain (both the `*.pages.dev` URL and any future custom
   domain), Include policy scoped to your email only. Unlike the public
   dashboard, restricting this one is the point.
4. **Verify before trusting it**:
   - Incognito/logged-out load → should redirect to Access login with zero
     page content leaking first.
   - Preview-deployment URLs (`<hash>.full-report-site.pages.dev`) get a
     separate hostname from production — confirm the Access policy covers
     them too (wildcard, or disable preview deployments).
   - Reload a few times to check nothing is served from cache pre-Access-
     evaluation.

## Data flow

`write_full_report` (mcp_server) → `full_report_snapshots` table (RLS
deny-all for anon/authenticated, only `service_role` can read/write) →
this Function reads the latest row + the latest `crash_checks` row (for the
context strip) → renders HTML server-side → Cloudflare Access gates who
ever sees the response.

No history browsing in v1 — the Function always renders the latest
snapshot. `full_report_snapshots` is being written every run regardless, so
history exists in the database for a future browsing UI without needing a
backfill later.
