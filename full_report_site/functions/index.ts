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

interface DriftEntry {
  fund: string;
  actual_pct: number;
  target_pct: number;
  drift_pts: number;
  status: "ON_TARGET" | "DRIFTED";
}

interface AccountDrift {
  account_key: string;
  label: string;
  entries: DriftEntry[];
  max_drift_pts: number;
  has_drifted: boolean;
}

interface PortfolioDrift {
  accounts: AccountDrift[];
  standing_flags: string[];
}

interface PortfolioReviewTicker {
  symbol: string;
  thesis_verdict: string;
  proposed_change: string | null;
  reasoning: string;
}

interface RiskRadarScores {
  geopolitical: number;
  policy_fed: number;
  inflation: number;
  valuation: number;
  labor_market: number;
  earnings: number;
}

interface PortfolioReviewRow {
  run_at: string;
  verdict: string | null;
  summary: string | null;
  macro_cross_reference: string | null;
  drift: PortfolioDrift | null;
  tickers: PortfolioReviewTicker[];
  risk_radar: RiskRadarScores | null;
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
  let portfolioReviews: PortfolioReviewRow[];
  try {
    [[fullReport], [crashCheck], portfolioReviews] = await Promise.all([
      supabaseGet<FullReportRow[]>(env, "full_report_snapshots?select=*&order=run_at.desc&limit=1"),
      supabaseGet<CrashCheckRow[]>(
        env,
        "crash_checks?select=run_at,crash_probability_pct,confirmed_red_count,red_count,wave_active,warsh_classification&order=run_at.desc&limit=1",
      ),
      supabaseGet<PortfolioReviewRow[]>(env, "portfolio_review_snapshots?select=*&order=run_at.desc&limit=2"),
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

  const [latestReview, priorReview] = portfolioReviews;

  return new Response(renderPage(fullReport, crashCheck, latestReview, priorReview?.risk_radar ?? null), {
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

// portfolio.yaml's fund keys are raw snake_case (e.g. "nyl_anchor",
// "jpm_equity_income") — readable as data, not as a page label. Splits on
// "_" and title-cases each word, except a small set of known finance
// acronyms that stay fully uppercase (plain title-case would otherwise
// produce "Nyl"/"Vg"/"Jpm").
const FUND_NAME_ACRONYMS = new Set(["nyl", "vg", "jpm", "tdam", "jh"]);

function formatFundName(fundKey: string): string {
  return fundKey
    .split("_")
    .map((word) =>
      FUND_NAME_ACRONYMS.has(word.toLowerCase()) ? word.toUpperCase() : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join(" ");
}

function statusBadgeClass(status: WatchlistEntry["status"]): string {
  if (status === "BUY_ZONE") return "good";
  if (status === "WATCH") return "warning";
  return "muted";
}

const RADAR_AXES: { key: keyof RiskRadarScores; label: string; labelX: number; labelY: number; anchor: string }[] = [
  { key: "geopolitical", label: "Geopolitical", labelX: 150, labelY: 20, anchor: "middle" },
  { key: "policy_fed", label: "Policy / Fed", labelX: 262, labelY: 80, anchor: "start" },
  { key: "inflation", label: "Inflation", labelX: 262, labelY: 224, anchor: "start" },
  { key: "valuation", label: "Valuation", labelX: 150, labelY: 288, anchor: "middle" },
  { key: "labor_market", label: "Labor Market", labelX: 38, labelY: 224, anchor: "end" },
  { key: "earnings", label: "Earnings", labelX: 38, labelY: 80, anchor: "end" },
];

// Hexagon math: 6 axes at 60-degree intervals starting straight up
// (-90 degrees), center (150,150), max radius 120 — matches the fixed grid
// ring/axis-line coordinates below exactly (verified against
// portfolio-review-template.html's hardcoded example values).
function radarPolygonPoints(scores: RiskRadarScores): string {
  const center = 150;
  const maxRadius = 120;
  return RADAR_AXES.map((axis, i) => {
    const value = Math.max(0, Math.min(100, scores[axis.key]));
    const angleRad = ((-90 + 60 * i) * Math.PI) / 180;
    const r = (value / 100) * maxRadius;
    const x = center + r * Math.cos(angleRad);
    const y = center + r * Math.sin(angleRad);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
}

function renderPortfolioReviewSection(
  review: PortfolioReviewRow,
  priorRadar: RiskRadarScores | null,
  watchlistBySymbol: Map<string, WatchlistEntry>,
): string {
  const driftRows = (review.drift?.accounts ?? [])
    .map((acct) => {
      const rows = acct.entries
        .map(
          (e) => `<div class="drift-row">
          <div class="drift-name">${escapeHtml(formatFundName(e.fund))}</div>
          <div class="drift-track"><div class="drift-fill" style="width:${Math.min(100, Math.max(0, e.actual_pct))}%;"></div><div class="drift-target" style="left:${Math.min(100, Math.max(0, e.target_pct))}%;"></div></div>
          <div class="drift-val">${e.actual_pct}% <span class="muted">(target ${e.target_pct}%)</span></div>
        </div>`,
        )
        .join("");
      return `<div class="drift-account-group">
        <p class="drift-account-label">${escapeHtml(acct.label)}</p>
        ${rows}
      </div>`;
    })
    .join("");

  const standingFlags = (review.drift?.standing_flags ?? [])
    .map((flag) => `<div class="flag-card">${escapeHtml(flag)}</div>`)
    .join("");

  const driftSection =
    driftRows || standingFlags
      ? `<section class="card"><p class="eyebrow">Portfolio Drift</p>${driftRows}${standingFlags}</section>`
      : "";

  const tickerCards = review.tickers
    .map((t) => {
      const wl = watchlistBySymbol.get(t.symbol);
      return `<div class="pr-ticker-card">
        <div class="ticker-head">
          <span class="ticker-symbol">${escapeHtml(t.symbol)}</span>
          ${wl ? `<span class="badge ${statusBadgeClass(wl.status)}">${escapeHtml(wl.status.replace("_", " "))}</span>` : ""}
        </div>
        ${wl ? `<div class="muted">${escapeHtml(wl.theme)} · $${wl.current_price?.toLocaleString("en-US") ?? "—"}</div>` : ""}
        <div class="thesis-verdict">${escapeHtml(t.thesis_verdict)}</div>
        <p class="narrative">${escapeHtml(t.reasoning)}</p>
        ${t.proposed_change ? `<div class="proposed-change"><b>Proposed:</b> ${escapeHtml(t.proposed_change)}</div>` : ""}
      </div>`;
    })
    .join("");

  const tickerSection = tickerCards
    ? `<section class="card"><p class="eyebrow">Watchlist Thesis Re-Underwrite</p><div class="pr-ticker-grid">${tickerCards}</div></section>`
    : "";

  const crossReferenceParagraphs = (review.macro_cross_reference ?? "")
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p class="narrative">${escapeHtml(p)}</p>`)
    .join("");

  const crossReferenceSection = crossReferenceParagraphs
    ? `<section class="card"><p class="eyebrow">Macro / Geopolitical Cross-Reference</p>${crossReferenceParagraphs}</section>`
    : "";

  const radarSection = review.risk_radar
    ? `<section class="card">
        <p class="eyebrow">Risk Radar — current vs. prior review</p>
        <div class="radar-wrap">
          <svg class="radar-svg" viewBox="0 0 300 300">
            <polygon class="radar-grid" points="150,110 184.6,130 184.6,170 150,190 115.4,170 115.4,130" />
            <polygon class="radar-grid" points="150,70 219.3,110 219.3,190 150,230 80.7,190 80.7,110" />
            <polygon class="radar-grid" points="150,30 253.9,90 253.9,210 150,270 46.1,210 46.1,90" />
            <line class="radar-axis" x1="150" y1="150" x2="150" y2="30" />
            <line class="radar-axis" x1="150" y1="150" x2="253.9" y2="90" />
            <line class="radar-axis" x1="150" y1="150" x2="253.9" y2="210" />
            <line class="radar-axis" x1="150" y1="150" x2="150" y2="270" />
            <line class="radar-axis" x1="150" y1="150" x2="46.1" y2="210" />
            <line class="radar-axis" x1="150" y1="150" x2="46.1" y2="90" />
            ${priorRadar ? `<polygon class="radar-prior" points="${radarPolygonPoints(priorRadar)}" />` : ""}
            <polygon class="radar-current" points="${radarPolygonPoints(review.risk_radar)}" />
            ${RADAR_AXES.map((axis) => `<text class="radar-label" x="${axis.labelX}" y="${axis.labelY}" text-anchor="${axis.anchor}">${axis.label}</text>`).join("")}
          </svg>
          <div class="radar-legend">
            <div><span class="sw current"></span>Current: ${RADAR_AXES.map((a) => `${a.label} ${review.risk_radar![a.key]}`).join(", ")}</div>
            ${priorRadar ? `<div><span class="sw prior"></span>Prior: ${RADAR_AXES.map((a) => `${a.label} ${priorRadar[a.key]}`).join(", ")}</div>` : ""}
          </div>
        </div>
      </section>`
    : "";

  return `
    <section class="card">
      <p class="eyebrow">Portfolio Opportunity Review</p>
      <p class="verdict">${escapeHtml(review.verdict ?? "")}</p>
      <p class="narrative">${escapeHtml(review.summary ?? "")}</p>
      <p class="subtitle" style="margin-top:10px;">Reviewed at ${escapeHtml(formatRunAt(review.run_at))}</p>
    </section>
    ${driftSection}
    ${tickerSection}
    ${crossReferenceSection}
    ${radarSection}
  `;
}

function renderPage(
  report: FullReportRow,
  crashCheck: CrashCheckRow | undefined,
  portfolioReview: PortfolioReviewRow | undefined,
  priorRadar: RiskRadarScores | null,
): string {
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

  const watchlistBySymbol = new Map(report.watchlist.map((t) => [t.symbol, t]));
  const portfolioReviewSection = portfolioReview
    ? renderPortfolioReviewSection(portfolioReview, priorRadar, watchlistBySymbol)
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
    ${portfolioReviewSection}
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

  .verdict { font-size: 17px; font-weight: 600; line-height: 1.4; margin: 0 0 8px; }

  .drift-account-group { margin-bottom: 14px; }
  .drift-account-group:last-of-type { margin-bottom: 0; }
  .drift-account-label { font-size: 12px; font-weight: 600; color: var(--text-primary); margin: 0 0 4px; }
  .drift-row { display: grid; grid-template-columns: 160px 1fr 140px; gap: 12px; align-items: center; padding: 7px 0; }
  .drift-name { font-size: 12px; color: var(--text-secondary); }
  .drift-track { position: relative; height: 8px; border-radius: 999px; background: var(--grid); }
  .drift-fill { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 999px; background: var(--neutral-blue); }
  .drift-target { position: absolute; top: -3px; bottom: -3px; width: 2px; background: var(--text-primary); opacity: 0.55; }
  .drift-val { font-size: 12px; text-align: right; color: var(--text-secondary); }
  .flag-card { margin-top: 10px; padding: 12px 14px; border-radius: 10px; background: var(--warning-bg); border: 1px solid var(--border); font-size: 12px; color: var(--text-secondary); line-height: 1.5; }

  .pr-ticker-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
  .pr-ticker-card { border: 1px solid var(--border); border-radius: 10px; padding: 14px; }
  .ticker-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 4px; }
  .thesis-verdict { font-size: 12px; font-weight: 600; margin: 8px 0 4px; }
  .proposed-change { font-size: 12px; color: var(--text-secondary); margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--border); }

  .radar-wrap { display: flex; align-items: center; gap: 20px; flex-wrap: wrap; }
  .radar-svg { width: 280px; height: 280px; flex-shrink: 0; }
  .radar-grid { fill: none; stroke: var(--grid); stroke-width: 1; }
  .radar-axis { stroke: var(--grid); stroke-width: 1; }
  .radar-label { font-size: 10px; fill: var(--text-secondary); }
  .radar-current { fill: var(--neutral-blue); fill-opacity: 0.18; stroke: var(--neutral-blue); stroke-width: 2; }
  .radar-prior { fill: none; stroke: var(--text-muted); stroke-width: 1.5; stroke-dasharray: 4 3; }
  .radar-legend { display: flex; flex-direction: column; gap: 8px; font-size: 12px; color: var(--text-secondary); max-width: 320px; }
  .radar-legend .sw { display: inline-block; width: 14px; height: 2px; margin-right: 6px; vertical-align: middle; }
  .radar-legend .sw.current { background: var(--neutral-blue); height: 3px; }
  .radar-legend .sw.prior { border-top: 2px dashed var(--text-muted); }

  @media (max-width: 700px) {
    .context-strip { grid-template-columns: repeat(2, 1fr); }
    .watchlist-table { display: block; overflow-x: auto; }
    .pr-ticker-grid { grid-template-columns: 1fr; }
    .drift-row { grid-template-columns: 1fr; gap: 4px; }
  }
`;
