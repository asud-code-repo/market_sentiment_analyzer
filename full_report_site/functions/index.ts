// Cloudflare Pages Function — the only reader of full_report_snapshots.
// Runs server-side at the edge, holds SUPABASE_SERVICE_ROLE_KEY as a
// Cloudflare-encrypted environment variable (never shipped to the browser),
// and returns pre-rendered HTML. Cloudflare Access sits in front of this
// entire project at the edge, so there's no client-side credential here to
// leak in the first place — see backlog_unify_crash_check_dashboard_site
// (project memory) for why this design was chosen over Access-alone or a
// two-tier Access+Supabase-Auth setup.
//
// No npm dependencies deliberately — plain fetch against Supabase's REST API
// (PostgREST), matching dashboard_site's zero-build-tooling simplicity.
// Cloudflare's Pages build compiles this TS file directly; the ambient
// PagesFunction/Response/fetch types come from their build pipeline, not a
// local @cloudflare/workers-types install.

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
}

interface CrashCheckRow {
  run_at: string;
  crash_probability_pct: number | null;
  confirmed_red_count: number | null;
  red_count: number;
  wave_active: string | null;
  warsh_classification: string | null;
}

interface WatchlistEntry {
  symbol: string;
  name: string;
  theme: string;
  wave1_target: number;
  wave2_target: number;
  wave3_target: number;
  wave3_only?: boolean;
  thesis_note?: string;
  current_price: number | null;
  price_as_of: string | null;
  pct_above_wave1: number | null;
  status: "BUY_ZONE" | "WATCH" | "WAIT" | "NO_PRICE_DATA";
}

interface CrashTypeCriterion {
  name: string;
  status: string;
  detail: string;
}

interface FullReportRow {
  run_at: string;
  watchlist: WatchlistEntry[];
  crash_type_diagnosis: { type: string; criteria: CrashTypeCriterion[] } | null;
  portfolio_context: string | null;
}

async function supabaseGet<T>(env: Env, path: string): Promise<T> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!res.ok) {
    throw new Error(`Supabase query failed (${res.status}) for ${path}`);
  }
  return res.json();
}

export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  let fullReport: FullReportRow | undefined;
  let crashCheck: CrashCheckRow | undefined;
  try {
    [[fullReport], [crashCheck]] = await Promise.all([
      supabaseGet<FullReportRow[]>(env, "full_report_snapshots?select=*&order=run_at.desc&limit=1"),
      supabaseGet<CrashCheckRow[]>(
        env,
        "crash_checks?select=run_at,crash_probability_pct,confirmed_red_count,red_count,wave_active,warsh_classification&order=run_at.desc&limit=1",
      ),
    ]);
  } catch (err) {
    return new Response(renderShell("Full Report unavailable", `<p>${escapeHtml(String(err))}</p>`), {
      status: 502,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  if (!fullReport) {
    return new Response(
      renderShell(
        "No Full Report snapshot yet",
        "<p>write_full_report hasn't been called yet — run a crash check in Claude first.</p>",
      ),
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );
  }

  return new Response(renderPage(fullReport, crashCheck), {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
};

// Rendered server-side with no client JS to adapt to the viewer's own
// locale/timezone (unlike dashboard_site's client-side toLocaleString), so
// this is pinned to US Eastern — consistent with the rest of this project's
// Eastern-time convention (ingest.yml's schedule, the data-freshness check).
function formatRunAt(isoString: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(isoString)) + " ET";
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function statusBadgeClass(status: WatchlistEntry["status"]): string {
  if (status === "BUY_ZONE") return "good";
  if (status === "WATCH") return "warning";
  return "muted";
}

function renderPage(report: FullReportRow, crashCheck: CrashCheckRow | undefined): string {
  const contextStrip = crashCheck
    ? `<div class="context-strip">
        <div class="stat"><div class="stat-label">Crash Probability</div><div class="stat-value">${crashCheck.crash_probability_pct ?? "—"}%</div></div>
        <div class="stat"><div class="stat-label">Confirmed RED</div><div class="stat-value">${crashCheck.confirmed_red_count ?? 0} / 6</div></div>
        <div class="stat"><div class="stat-label">Wave Active</div><div class="stat-value">${escapeHtml(crashCheck.wave_active ?? "NONE")}</div></div>
        <div class="stat"><div class="stat-label">Fed Regime</div><div class="stat-value">${escapeHtml(crashCheck.warsh_classification ?? "PENDING")}</div></div>
      </div>`
    : "";

  const diagnosis = report.crash_type_diagnosis
    ? `<section class="card">
        <p class="eyebrow">Crash-Type Diagnosis</p>
        <h2 class="diagnosis-type">${escapeHtml(report.crash_type_diagnosis.type)}</h2>
        <ul class="criteria-list">
          ${report.crash_type_diagnosis.criteria
            .map((c) => `<li><b>${escapeHtml(c.name)}:</b> ${escapeHtml(c.status)} — ${escapeHtml(c.detail)}</li>`)
            .join("")}
        </ul>
      </section>`
    : "";

  const watchlistRows = report.watchlist
    .map(
      (t) => `<tr>
        <td class="ticker-symbol">${escapeHtml(t.symbol)}</td>
        <td>${escapeHtml(t.name)}</td>
        <td class="muted">${escapeHtml(t.theme)}</td>
        <td>${t.current_price != null ? "$" + t.current_price.toLocaleString("en-US") : "—"}</td>
        <td class="muted">W1 ${t.wave1_target.toLocaleString("en-US")} / W2 ${t.wave2_target.toLocaleString("en-US")} / W3 ${t.wave3_target.toLocaleString("en-US")}</td>
        <td>${t.pct_above_wave1 != null ? t.pct_above_wave1 + "%" : "—"}</td>
        <td><span class="badge ${statusBadgeClass(t.status)}">${escapeHtml(t.status.replace("_", " "))}</span></td>
      </tr>`,
    )
    .join("");

  const portfolioContext = report.portfolio_context
    ? `<section class="card"><p class="eyebrow">Personal Portfolio Context</p><p class="narrative">${escapeHtml(report.portfolio_context)}</p></section>`
    : "";

  const body = `
    <p class="subtitle">Run at ${escapeHtml(formatRunAt(report.run_at))} · <a href="https://market-sentiment-analyzer.pages.dev/">Public dashboard →</a></p>
    ${contextStrip}
    ${diagnosis}
    <section class="card">
      <p class="eyebrow">BrokerageLink Watchlist</p>
      <table class="watchlist-table">
        <thead><tr><th>Ticker</th><th>Name</th><th>Theme</th><th>Price</th><th>Wave Targets</th><th>vs W1</th><th>Status</th></tr></thead>
        <tbody>${watchlistRows}</tbody>
      </table>
    </section>
    ${portfolioContext}
  `;
  return renderShell("Full Report", body);
}

function renderShell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Macro Crash Check — ${escapeHtml(title)}</title>
<link rel="manifest" href="/manifest.json">
<link rel="apple-touch-icon" href="/icon-192.png">
<meta name="theme-color" content="#0d0d0d">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Full Report">
<style>${PAGE_CSS}</style>
</head>
<body>
<div class="wrap">
  <h1>${escapeHtml(title)}</h1>
  ${body}
</div>
</body>
</html>`;
}

const PAGE_CSS = `
  :root {
    --surface-1: #fcfcfb; --page: #f9f9f7; --text-primary: #0b0b0b; --text-secondary: #52514e;
    --text-muted: #898781; --grid: #e1e0d9; --border: rgba(11,11,11,0.10);
    --good: #0ca30c; --good-bg: #e8f7e6; --warning: #b8790a; --warning-bg: #fdf1d8;
    --critical: #d03b3b; --critical-bg: #fbe7e6; --neutral-blue: #2a78d6;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --surface-1: #1a1a19; --page: #0d0d0d; --text-primary: #ffffff; --text-secondary: #c3c2b7;
      --text-muted: #898781; --grid: #2c2c2a; --border: rgba(255,255,255,0.10);
      --good: #0ca30c; --good-bg: #10250f; --warning: #fab219; --warning-bg: #2c2109;
      --critical: #e66767; --critical-bg: #2c1211; --neutral-blue: #3987e5;
    }
  }
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; background: var(--page); color: var(--text-primary); margin: 0; padding: 24px; }
  .wrap { max-width: 1100px; margin: 0 auto; display: flex; flex-direction: column; gap: 16px; }
  h1 { font-size: 20px; margin: 0; }
  .subtitle { font-size: 13px; color: var(--text-muted); margin: 0 0 8px; }
  .subtitle a { color: var(--neutral-blue); }
  .card { background: var(--surface-1); border: 1px solid var(--border); border-radius: 12px; padding: 20px; }
  .eyebrow { font-size: 11px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-muted); margin: 0 0 10px; }
  .context-strip { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
  .stat { background: var(--surface-1); border: 1px solid var(--border); border-radius: 12px; padding: 14px 16px; }
  .stat-label { font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 6px; }
  .stat-value { font-size: 22px; font-weight: 600; }
  .diagnosis-type { font-size: 18px; margin: 0 0 12px; }
  .criteria-list { margin: 0; padding-left: 18px; font-size: 13px; line-height: 1.6; color: var(--text-secondary); }
  .watchlist-table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .watchlist-table th { text-align: left; font-size: 11px; text-transform: uppercase; color: var(--text-muted); padding: 6px 8px; border-bottom: 1px solid var(--grid); }
  .watchlist-table td { padding: 8px; border-bottom: 1px solid var(--grid); }
  .ticker-symbol { font-weight: 600; }
  .muted { color: var(--text-muted); }
  .narrative { font-size: 14px; line-height: 1.6; color: var(--text-secondary); margin: 0; white-space: pre-wrap; }
  .badge { display: inline-block; padding: 3px 9px; border-radius: 999px; font-size: 11px; font-weight: 600; }
  .badge.good { background: var(--good-bg); color: var(--good); }
  .badge.warning { background: var(--warning-bg); color: var(--warning); }
  .badge.muted { background: var(--grid); color: var(--text-muted); }
  @media (max-width: 700px) {
    .context-strip { grid-template-columns: repeat(2, 1fr); }
    .watchlist-table { display: block; overflow-x: auto; }
  }
`;
