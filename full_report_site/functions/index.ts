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
  wave_authorized: boolean | null;
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

interface ConfirmationEntry {
  color: string;
  confirmed: boolean;
  days_confirmed: number;
  observation_date: string;
}

// Written by mcp_server's write_full_report from the local policy; null on
// snapshots from before 2026-11-14.
interface WaveStatus {
  wave_active: string;
  wave_active_reason: string | null;
  fast_panic_wave: string;
  slow_bear: { w2: ConfirmationEntry | null; w3: ConfirmationEntry | null };
  wave_authorized: boolean;
  as_of_observation_date: string | null;
}

interface PersonalTrigger {
  name: string;
  status: string;
  note: string;
}

interface InsiderSignal {
  ticker: string;
  distinct_officer_director_buyers_30d: number;
  cluster_buy_signal: boolean;
  total_sell_count_30d: number;
  latest_transaction_date: string | null;
}

interface FullReportRow {
  run_at: string;
  watchlist: WatchlistEntry[];
  crash_type_diagnosis: { type: string; criteria: CrashTypeCriterion[] } | null;
  portfolio_context: string | null;
  wave_status?: WaveStatus | null;
  personal_triggers?: PersonalTrigger[] | null;
  insider_activity?: InsiderSignal[] | null;
}

interface DriftEntry {
  fund: string;
  label?: string;
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

interface PortfolioReviewRow {
  run_at: string;
  verdict: string | null;
  summary: string | null;
  macro_cross_reference: string | null;
  drift: PortfolioDrift | null;
  tickers: PortfolioReviewTicker[];
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
        "crash_checks?select=run_at,crash_probability_pct,confirmed_red_count,red_count,wave_authorized,warsh_classification&order=run_at.desc&limit=1",
      ),
      supabaseGet<PortfolioReviewRow[]>(env, "portfolio_review_snapshots?select=run_at,verdict,summary,macro_cross_reference,drift,tickers&order=run_at.desc&limit=1"),
    ]);
  } catch (err) {
    return new Response(renderShell("Private Portfolio Report unavailable", `<p>${escapeHtml(String(err))}</p>`), {
      status: 502,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  }

  if (!fullReport) {
    return new Response(
      renderShell(
        "No Private Portfolio Report snapshot yet",
        "<p>write_full_report hasn't been called yet — run a crash check in Claude first.</p>",
      ),
      { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
    );
  }

  const [latestReview] = portfolioReviews;

  return new Response(renderPage(fullReport, crashCheck, latestReview), {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
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

// Free-text narratives (notes, portfolio context, summaries) are often
// written as one long run of sentences. Show them as short paragraphs:
// keep the author's own line breaks when there are any, otherwise group
// sentences into paragraphs of roughly 300 characters. Display-only; the
// stored text is never changed. Duplicated in dashboard_site (no shared
// code between the two static sites, same as every other helper).
const PARA_ABBR = /(?:\b(?:U\.S|U\.K|e\.g|i\.e|vs|approx|est|Inc|Corp|Co|Ltd|St|Mr|Ms|Dr|No|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)|\b[A-Z])\.$/;
function toParagraphs(text: string | null | undefined): string[] {
  const t = String(text ?? "").trim();
  if (!t) return [];
  if (t.includes("\n")) return t.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  const sentences: string[] = [];
  for (const part of t.split(/(?<=[.!?])\s+(?=[A-Z0-9("'\u201c])/)) {
    if (sentences.length && PARA_ABBR.test(sentences[sentences.length - 1])) sentences[sentences.length - 1] += " " + part;
    else sentences.push(part);
  }
  const out: string[] = [];
  let cur = "";
  for (const s of sentences) {
    cur = cur ? cur + " " + s : s;
    if (cur.length >= 280) { out.push(cur); cur = ""; }
  }
  if (cur) { if (out.length && cur.length < 120) out[out.length - 1] += " " + cur; else out.push(cur); }
  return out;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Drift entries carry a display `label` from portfolio.yaml's local
// fund_labels map (added by mcp_server before writing). Older snapshots
// without one fall back to title-casing the raw snake_case key.
function formatFundName(fundKey: string, label?: string): string {
  if (label) return label;
  return fundKey
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

// ---------------------------------------------------------------------------
// Rendering (restyled 2026-11-14 to match the public dashboard: top bar with
// a segmented tab control, a verdict header, hairline "ledger" tables with a
// coloured status edge, and a side rail on desktop). Two tabs: Deployment
// (waves, watchlist, insider activity, crash type, triggers, context) and
// Portfolio (drift, thesis re-underwrite, summary, macro cross-reference).
// ---------------------------------------------------------------------------

const PUBLIC_DASHBOARD_URL = "https://marketstress.org/";

type Tone = "good" | "warning" | "critical" | "muted";

const toneAttr = (t: Tone | "") => (t ? ` data-status="${t}"` : "");
const pill = (text: string, tone: Tone) => `<span class="pill"${toneAttr(tone)}>${escapeHtml(text)}</span>`;
const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

function formatShortDate(isoDate: string | null | undefined): string {
  if (!isoDate) return "—";
  const d = new Date(isoDate.length === 10 ? `${isoDate}T12:00:00Z` : isoDate);
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" }).format(d);
}

// "WAVE_2" -> "Wave 2"
const waveName = (w: string) => w.replace(/^WAVE_(\d)$/, "Wave $1");
// WaveActive is "NONE" | "WAVE_1".."WAVE_3"; anything else counts as no wave.
const isWave = (w: string | null | undefined) => !!w && /^WAVE_\d$/.test(w);

// Free-text statuses written by the run (criteria, personal triggers):
// highlight the ones that mean "this is happening", keep the rest quiet.
function toneForText(status: string): Tone {
  const s = status.trim().toLowerCase();
  if (/\bnot\b|^no\b|pending|none|n\/a|unchanged|^ok\b|clear/.test(s)) return "muted";
  if (/met|fired|triggered|active|red|due|yes|breach/.test(s)) return "warning";
  return "muted";
}

function watchTone(status: WatchlistEntry["status"]): Tone {
  if (status === "BUY_ZONE") return "good";
  if (status === "WATCH") return "warning";
  return "muted";
}

function confirmationCell(e: ConfirmationEntry | null | undefined): { reading: string; status: string; tone: Tone } {
  if (!e) return { reading: "—", status: "No data", tone: "muted" };
  if (e.color !== "RED") return { reading: titleCase(e.color), status: "Not triggered", tone: e.color === "AMBER" ? "warning" : "good" };
  return e.confirmed
    ? { reading: `Red since ${formatShortDate(e.observation_date)}`, status: "Confirmed", tone: "critical" }
    : { reading: `Red, ${e.days_confirmed} date${e.days_confirmed === 1 ? "" : "s"} so far`, status: "Pending", tone: "warning" };
}

function renderTopbar(activeTab: string, runAt: string | null, withTabs: boolean): string {
  const tabs = withTabs
    ? `<nav class="tab-bar" id="tab-bar" aria-label="Sections">
        <button class="tab-btn${activeTab === "deploy" ? " active" : ""}" data-tab="deploy">Deployment</button>
        <button class="tab-btn${activeTab === "portfolio" ? " active" : ""}" data-tab="portfolio">Portfolio</button>
      </nav>`
    : "<span></span>";
  return `<header class="topbar">
    <div class="brand">Stress Monitor <i>· private report</i></div>
    ${tabs}
    <div class="topright">
      ${runAt ? `<span class="when">Run ${escapeHtml(formatRunAt(runAt))}</span>` : ""}
      <a class="ext" href="${PUBLIC_DASHBOARD_URL}">Public dashboard ↗</a>
      <button class="dn-btn" id="refresh-btn" title="Refresh">&#8635;</button>
    </div>
  </header>`;
}

function renderDeploymentTab(report: FullReportRow, crashCheck: CrashCheckRow | undefined): string {
  const ws = report.wave_status;
  const confirmed = crashCheck?.confirmed_red_count ?? null;

  // ---- verdict header ----
  let big = "No wave";
  let subTone = "ok";
  let subLead = "Stress gate not met";
  if (ws && isWave(ws.wave_active)) {
    big = waveName(ws.wave_active);
    subTone = ws.wave_authorized ? "bad" : "warn";
    subLead = `${ws.wave_active_reason === "SLOW_BEAR" ? "Slow bear · " : ws.wave_active_reason === "FAST_PANIC" ? "Fast panic · " : ""}${ws.wave_authorized ? "authorized" : "observed, not authorized"}`;
  } else if (ws?.wave_authorized) {
    subTone = "warn";
    subLead = "Stress gate met";
  } else if (!ws) {
    big = "Wave status n/a";
    subTone = "";
    subLead = "Snapshot predates wave status";
  }
  const firing = ws
    ? [isWave(ws.fast_panic_wave), ws.slow_bear?.w2?.color === "RED", ws.slow_bear?.w3?.color === "RED"].filter(Boolean).length
    : null;
  const buyZone = report.watchlist.filter((t) => t.status === "BUY_ZONE").length;
  const verdict = `<div class="verdict">
    <div class="headline"><span class="big">${escapeHtml(big)}</span><span class="sub"><b class="${subTone}">${escapeHtml(subLead)}</b>${confirmed != null ? ` · ${confirmed} of 6 confirmed red` : ""}${firing != null ? ` · ${firing} of 3 pathways firing` : ""}</span></div>
    <div class="facts">
      ${crashCheck ? `<div class="fact"><span class="lbl">Fed regime</span><span class="v">${escapeHtml(titleCase(crashCheck.warsh_classification ?? "Pending"))}</span></div>` : ""}
      ${crashCheck?.crash_probability_pct != null ? `<div class="fact"><span class="lbl">LLM crash est.</span><span class="v">${crashCheck.crash_probability_pct}% <small>discretionary</small></span></div>` : ""}
      <div class="fact"><span class="lbl">Crash type</span><span class="v">${report.crash_type_diagnosis ? "Diagnosed <small>see right</small>" : "None <small>this run</small>"}</span></div>
      <div class="fact"><span class="lbl">Watchlist</span><span class="v">${buyZone} in buy zone <small>of ${report.watchlist.length}</small></span></div>
    </div>
    <div class="stamp"><b>As of ${escapeHtml(formatRunAt(report.run_at))}</b>${ws?.as_of_observation_date ? `<br>S&amp;P reading ${escapeHtml(formatShortDate(ws.as_of_observation_date))}` : ""}</div>
  </div>`;

  // ---- wave pathways ----
  let pathways = "";
  if (ws) {
    const fast = isWave(ws.fast_panic_wave);
    const w2 = confirmationCell(ws.slow_bear?.w2);
    const w3 = confirmationCell(ws.slow_bear?.w3);
    const rows: [string, string, string, string, Tone][] = [
      ["Stress gate", "3 of 6 indicators at confirmed red", confirmed != null ? `${confirmed} of 6 confirmed` : "—", ws.wave_authorized ? "Met" : "Not met", ws.wave_authorized ? "critical" : "good"],
      ["Fast panic", "S&amp;P drawdown + VIX, same day", fast ? waveName(ws.fast_panic_wave) : "None", fast ? "Triggered" : "Not triggered", fast ? "critical" : "good"],
      ["Slow bear · Wave 2", "Drawdown held at a fresh low", escapeHtml(w2.reading), w2.status, w2.tone],
      ["Slow bear · Wave 3", "Deeper drawdown, held", escapeHtml(w3.reading), w3.status, w3.tone],
    ];
    pathways = `<section class="rsec">
      <div class="sh"><span class="lbl">Wave pathways</span><span class="note">Evaluated locally from the private deployment policy</span></div>
      <div class="ledger pw">
        <div class="row hdr"><span>Pathway</span><span>Reading</span><span class="r">Status</span></div>
        ${rows.map(([n, s, r, st, t]) => `<div class="row"${toneAttr(t)}><div class="name"><b>${n}</b><small>${s}</small></div><div class="det">${r}</div><div class="r">${pill(st, t)}</div></div>`).join("")}
      </div>
    </section>`;
  }

  // ---- watchlist: price against the wave targets ----
  const wlRows = report.watchlist
    .map((t) => {
      const tone = watchTone(t.status);
      const p = t.current_price;
      const lo = Math.min(t.wave3_target, p ?? t.wave3_target) * 0.9;
      const hi = Math.max(t.wave1_target, p ?? t.wave1_target) * 1.12;
      const x = (v: number) => (((v - lo) / (hi - lo)) * 100).toFixed(1);
      const marks = (t.wave3_only ? [[t.wave3_target, "W3"]] : [[t.wave3_target, "W3"], [t.wave2_target, "W2"], [t.wave1_target, "W1"]]) as [number, string][];
      const buyEdge = t.wave3_only ? t.wave3_target : t.wave1_target;
      const rail = `<div class="wrail" style="--w1:${x(buyEdge)}%"><span class="ln"></span>
        ${marks.map(([v, l]) => `<span class="tk" style="left:${x(v)}%"></span><span class="tl" style="left:${x(v)}%">${l} ${v.toLocaleString("en-US")}</span>`).join("")}
        ${p != null ? `<span class="dot"${toneAttr(tone)} style="left:${x(p)}%"></span>` : ""}</div>`;
      const vs = t.pct_above_wave1;
      return `<div class="row"${toneAttr(tone)}>
        <div class="name"><b>${escapeHtml(t.symbol)}</b> <span class="sub">${escapeHtml(t.name)}</span><small>${escapeHtml(t.theme)}${t.wave3_only ? " · Wave 3 only" : ""}</small></div>
        <div class="num">${p != null ? "$" + p.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—"}</div>
        <div class="railc">${rail}</div>
        <div class="num vs">${vs != null ? `${vs >= 0 ? "+" : "−"}${Math.abs(vs).toFixed(1)}<small>%</small>` : "—"}</div>
        <div class="r">${pill(t.status.replace("_", " "), tone)}</div>
      </div>`;
    })
    .join("");
  const watchlist = `<section class="rsec">
    <div class="sh"><span class="lbl">Watchlist</span><span class="note">Price against the wave entry targets · green stretch = buy zone</span></div>
    ${wlRows ? `<div class="ledger wl"><div class="row hdr"><span>Ticker</span><span class="r">Price</span><span>vs wave targets</span><span class="r">vs W1</span><span class="r">Status</span></div>${wlRows}</div>` : `<p class="nar auto">No watchlist tickers.</p>`}
  </section>`;

  // ---- insider activity ----
  const ins = report.insider_activity ?? [];
  const insider = ins.length
    ? `<section class="rsec">
        <div class="sh"><span class="lbl">Insider activity · watchlist</span><span class="note">SEC Form 4, last 30 days</span></div>
        <div class="ledger ins">
          <div class="row hdr"><span>Ticker</span><span>Signal</span><span class="r">Officer/director buyers</span><span class="r">Sells</span><span class="r">Latest filing</span></div>
          ${ins.map((i) => `<div class="row"${toneAttr(i.cluster_buy_signal ? "good" : "")}>
            <div class="name"><b>${escapeHtml(i.ticker)}</b></div>
            <div>${i.cluster_buy_signal ? pill("Cluster buy", "good") : `<span class="sub">—</span>`}</div>
            <div class="num">${i.distinct_officer_director_buyers_30d}<small class="ph"> buyers</small></div>
            <div class="num">${i.total_sell_count_30d}<small class="ph"> sells</small></div>
            <div class="r sub dt">${escapeHtml(formatShortDate(i.latest_transaction_date))}</div>
          </div>`).join("")}
        </div>
      </section>`
    : "";

  // ---- rail ----
  const d = report.crash_type_diagnosis;
  const diagnosis = `<section class="rsec">
    <div class="sh"><span class="lbl">Crash-type diagnosis</span></div>
    ${d ? `<p class="dtype">${escapeHtml(d.type)}</p>
      <ul class="crit">${d.criteria.map((c) => `<li><b>${escapeHtml(c.name)}</b>${pill(c.status, toneForText(c.status))}<span class="d">${escapeHtml(c.detail)}</span></li>`).join("")}</ul>`
      : `<p class="nar auto">No crash type diagnosed this run.</p>`}
  </section>`;
  const trig = report.personal_triggers ?? [];
  const triggers = trig.length
    ? `<section class="rsec"><div class="sh"><span class="lbl">Personal triggers</span></div>
        <ul class="crit">${trig.map((t) => `<li><b>${escapeHtml(t.name)}</b>${pill(titleCase(t.status), toneForText(t.status))}<span class="d">${escapeHtml(t.note)}</span></li>`).join("")}</ul></section>`
    : "";
  const context = report.portfolio_context
    ? `<section class="rsec"><div class="sh"><span class="lbl">Portfolio context</span><span class="note">Qualitative only</span></div><div class="nars">${toParagraphs(report.portfolio_context).map((para) => `<p class="nar">${escapeHtml(para)}</p>`).join("")}</div></section>`
    : "";

  return `${verdict}
    <div class="cols">
      <div class="col-main">${pathways}${watchlist}${insider}</div>
      <aside class="col-rail">${diagnosis}${triggers}${context}</aside>
    </div>`;
}

function renderPortfolioTab(review: PortfolioReviewRow | undefined, watchlistBySymbol: Map<string, WatchlistEntry>): string {
  if (!review) {
    return `<div class="verdict"><div class="headline"><span class="big">No review yet</span><span class="sub">Run a Portfolio Opportunity Review in Claude to fill this tab.</span></div></div>`;
  }
  const accounts = review.drift?.accounts ?? [];
  const funds = accounts.reduce((n, a) => n + a.entries.length, 0);
  const drifted = accounts.reduce((n, a) => n + a.entries.filter((e) => e.status === "DRIFTED").length, 0);
  const proposed = review.tickers.filter((t) => t.proposed_change).length;
  const verdictText = review.verdict ?? "Review";
  const verdict = `<div class="verdict">
    <div class="headline"><span class="big${verdictText.length > 18 ? " long" : ""}">${escapeHtml(verdictText)}</span>
      <span class="sub">${drifted ? `<b class="warn">${drifted} fund${drifted === 1 ? "" : "s"} drifted</b>` : `<b class="ok">On target</b>`} · ${proposed} proposed change${proposed === 1 ? "" : "s"}</span></div>
    <div class="facts">
      <div class="fact"><span class="lbl">Accounts</span><span class="v">${accounts.length} <small>${funds} funds</small></span></div>
      <div class="fact"><span class="lbl">Drifted</span><span class="v"${drifted ? ' style="color:var(--warning)"' : ""}>${drifted} <small>of ${funds}</small></span></div>
      <div class="fact"><span class="lbl">Theses reviewed</span><span class="v">${review.tickers.length}</span></div>
    </div>
    <div class="stamp"><b>Reviewed ${escapeHtml(formatRunAt(review.run_at))}</b><br>Portfolio Opportunity Review</div>
  </div>`;

  const summary = review.summary
    ? `<div class="sh"><span class="lbl">Summary</span></div><div class="nars">${toParagraphs(review.summary).map((para) => `<p class="nar">${escapeHtml(para)}</p>`).join("")}</div>`
    : "";

  // ---- drift ----
  const driftGroups = accounts
    .map((acct) => {
      const n = acct.entries.filter((e) => e.status === "DRIFTED").length;
      const rows = acct.entries
        .map((e) => {
          const off = e.status === "DRIFTED";
          const clamp = (v: number) => Math.min(100, Math.max(0, v));
          return `<div class="row"${toneAttr(off ? "warning" : "")}>
            <div class="name"><b>${escapeHtml(formatFundName(e.fund, e.label))}</b></div>
            <div class="barc"><div class="dbar"><span class="f"${toneAttr(off ? "warning" : "")} style="width:${clamp(e.actual_pct)}%"></span><span class="t" style="left:${clamp(e.target_pct)}%"></span></div></div>
            <div class="num">${e.actual_pct}<small>% · target ${e.target_pct}%</small></div>
            <div class="r">${pill(`${e.drift_pts >= 0 ? "+" : "−"}${Math.abs(e.drift_pts).toFixed(1)} pts`, off ? "warning" : "muted")}</div>
          </div>`;
        })
        .join("");
      return `<div class="grp">${escapeHtml(acct.label)}<small>${n ? `${n} drifted` : "on target"}</small></div><div class="ledger dr">${rows}</div>`;
    })
    .join("");
  const flags = (review.drift?.standing_flags ?? []).map((f) => `<div class="flagnote"><b>Standing flag:</b> ${escapeHtml(f)}</div>`).join("");
  const drift = driftGroups || flags
    ? `<section class="rsec"><div class="sh"><span class="lbl">Allocation drift</span><span class="note">Bar = actual · blue mark = target</span></div>${driftGroups}${flags}</section>`
    : "";

  // ---- thesis re-underwrite ----
  const thRows = review.tickers
    .map((t) => {
      const wl = watchlistBySymbol.get(t.symbol);
      return `<div class="row"${toneAttr(t.proposed_change ? "warning" : "")}>
        <div class="name"><b>${escapeHtml(t.symbol)}</b>${wl ? `<small>${pill(wl.status.replace("_", " "), watchTone(wl.status))}</small>` : ""}</div>
        <div class="body"><div class="verd">${escapeHtml(t.thesis_verdict)}</div><div class="why">${escapeHtml(t.reasoning)}</div></div>
        <div class="r">${t.proposed_change ? `<span class="chip">${escapeHtml(t.proposed_change)}</span>` : `<span class="sub">No change</span>`}</div>
      </div>`;
    })
    .join("");
  const thesis = thRows
    ? `<section class="rsec"><div class="sh"><span class="lbl">Watchlist thesis re-underwrite</span></div>
        <div class="ledger th"><div class="row hdr"><span>Ticker</span><span>Verdict and reasoning</span><span class="r">Proposed</span></div>${thRows}</div></section>`
    : "";

  const crossRef = toParagraphs(review.macro_cross_reference)
    .map((p) => `<p class="nar">${escapeHtml(p)}</p>`)
    .join("");

  // Summary appears at the top on narrow screens (under the verdict) and in
  // the rail on wide ones -- rendered twice, one copy hidden per layout.
  return `${verdict}
    <div class="cols">
      <div class="col-main">${summary ? `<section class="rsec narrow-only">${summary}</section>` : ""}${drift}${thesis}</div>
      <aside class="col-rail">
        ${summary ? `<section class="rsec wide-only">${summary}</section>` : ""}
        ${crossRef ? `<section class="rsec"><div class="sh"><span class="lbl">Macro cross-reference</span></div><div class="nars">${crossRef}</div></section>` : ""}
      </aside>
    </div>`;
}

function renderPage(
  report: FullReportRow,
  crashCheck: CrashCheckRow | undefined,
  portfolioReview: PortfolioReviewRow | undefined,
): string {
  const watchlistBySymbol = new Map(report.watchlist.map((t) => [t.symbol, t]));
  const body = `${renderTopbar("deploy", report.run_at, true)}
    <div class="tab-panel" id="tab-deploy">${renderDeploymentTab(report, crashCheck)}</div>
    <div class="tab-panel" id="tab-portfolio" hidden>${renderPortfolioTab(portfolioReview, watchlistBySymbol)}</div>
    <p class="foot">Stress-monitoring dashboard with discretionary LLM judgment, not a calibrated forecast.</p>`;
  return renderShell("Private Portfolio Report", body, true);
}

function renderShell(title: string, body: string, full = false): string {
  const content = full
    ? body
    : `${renderTopbar("", null, false)}<div class="verdict"><div class="headline"><span class="big long">${escapeHtml(title)}</span></div></div><div class="nar" style="padding-top:16px">${body}</div>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Macro Market Stress Monitor — ${escapeHtml(title)}</title>
<link rel="manifest" href="/manifest.json?v=2">
<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png?v=2">
<link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png?v=2">
<meta name="theme-color" content="#0d0d0d">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Portfolio Report">
<style>${PAGE_CSS}</style>
</head>
<body>
<div class="wrap">
${content}
</div>
<script>
  // Installed-PWA refresh button: a normal browser tab has its own reload.
  if (window.navigator.standalone === true || window.matchMedia("(display-mode: standalone)").matches) {
    var refreshBtn = document.getElementById("refresh-btn");
    refreshBtn.style.display = "inline-block";
    refreshBtn.addEventListener("click", function () { location.reload(); });
  }
  // Tabs: remembered per browser; the page renders fine without storage.
  (function () {
    var bar = document.getElementById("tab-bar");
    if (!bar) return;
    function show(id) {
      var btns = bar.querySelectorAll(".tab-btn"), i;
      for (i = 0; i < btns.length; i++) btns[i].classList.toggle("active", btns[i].getAttribute("data-tab") === id);
      var panels = document.querySelectorAll(".tab-panel");
      for (i = 0; i < panels.length; i++) panels[i].hidden = panels[i].id !== "tab-" + id;
      try { localStorage.setItem("frTab", id); } catch (e) {}
    }
    bar.addEventListener("click", function (e) {
      var b = e.target.closest(".tab-btn");
      if (b) show(b.getAttribute("data-tab"));
    });
    try { var saved = localStorage.getItem("frTab"); if (saved === "portfolio") show(saved); } catch (e) {}
  })();
</script>
</body>
</html>`;
}

// Same tokens and building blocks as dashboard_site (body.rd), copied rather
// than shared: the two sites deploy separately and this one has no build step.
const PAGE_CSS = `
  :root {
    color-scheme: light dark;
    --page:#f9f9f7; --surface-1:#fcfcfb; --sunk:#f1f0ec; --hair:rgba(11,11,11,.09); --hair-strong:rgba(11,11,11,.16);
    --text-primary:#0b0b0b; --text-secondary:#52514e; --text-muted:#6f6d67;
    --good:#0a8a0a; --warning:#a86e08; --warning-bg:#fbf1dc; --critical:#c73434; --critical-bg:#fbe7e6;
    --accent:#2a78d6;
    --font-ui: system-ui, -apple-system, "Segoe UI", sans-serif;
    --t1: 600 26px/1.1 var(--font-ui); --t2: 400 13px/1.4 var(--font-ui); --t2-num: 600 15px/1.2 var(--font-ui);
    --t3: 400 11px/1.35 var(--font-ui); --label: 600 10.5px/1 var(--font-ui);
  }
  @media (prefers-color-scheme: dark) { :root {
    --page:#0d0d0d; --surface-1:#161615; --sunk:#121211; --hair:rgba(255,255,255,.08); --hair-strong:rgba(255,255,255,.15);
    --text-primary:#f4f4f1; --text-secondary:#c3c2b7; --text-muted:#9a988f;
    --good:#2fb52f; --warning-bg:#251c08; --critical-bg:#2c1211; --accent:#5a9cec;
  } }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--page); color:var(--text-primary); font:var(--t2); font-variant-numeric:tabular-nums lining-nums; -webkit-font-smoothing:antialiased; }
  button { font:inherit; color:inherit; }
  .wrap { max-width:1440px; margin:0 auto; padding:0 28px 40px; }
  .lbl { font:var(--label); letter-spacing:.07em; text-transform:uppercase; color:var(--text-muted); }
  [data-status=good] { --tick:var(--good); } [data-status=warning] { --tick:var(--warning); }
  [data-status=critical] { --tick:var(--critical); } [data-status=muted] { --tick:var(--text-muted); }

  /* top bar + tabs */
  .topbar { display:grid; grid-template-columns:minmax(0,1fr) auto minmax(0,1fr); align-items:center; gap:28px; height:46px; border-bottom:1px solid var(--hair); }
  .brand { font:600 13px/1 var(--font-ui); letter-spacing:.01em; white-space:nowrap; }
  .brand i { font-style:normal; color:var(--text-muted); font-weight:400; }
  .tab-bar { display:flex; gap:2px; padding:3px; border:1px solid var(--hair-strong); border-radius:8px; }
  .tab-btn { all:unset; box-sizing:border-box; cursor:pointer; display:flex; align-items:center; justify-content:center; padding:6px 14px; border-radius:6px;
    font:500 13px/1.15 var(--font-ui); color:var(--text-secondary); white-space:nowrap; }
  .tab-btn:hover { color:var(--text-primary); background:color-mix(in srgb, var(--text-primary) 6%, transparent); }
  .tab-btn.active { color:var(--text-primary); font-weight:600; background:color-mix(in srgb, var(--text-primary) 14%, transparent); }
  .tab-btn:focus-visible { outline:2px solid var(--accent); outline-offset:1px; }
  .topright { justify-self:end; display:flex; align-items:center; gap:12px; min-width:0; }
  .topright .when { font:var(--t3); color:var(--text-muted); white-space:nowrap; }
  .topright .ext { font:var(--t3); color:var(--accent); text-decoration:none; white-space:nowrap; }
  #refresh-btn { display:none; background:none; border:1px solid var(--hair-strong); border-radius:4px; min-width:26px; height:22px; padding:0 6px; cursor:pointer; color:var(--text-secondary); font:500 13px/1 var(--font-ui); }

  /* verdict header */
  .verdict { display:grid; grid-template-columns:auto 1fr auto; align-items:end; gap:40px; padding:22px 0 18px; border-bottom:1px solid var(--hair); }
  .headline { display:flex; align-items:baseline; gap:14px; min-width:0; }
  .headline .big { font:var(--t1); white-space:nowrap; }
  .headline .big.long { font-size:21px; white-space:normal; max-width:520px; }
  .headline .sub { font:500 13px/1.3 var(--font-ui); color:var(--text-secondary); }
  .headline .sub b { font-weight:600; color:var(--text-primary); }
  .headline .sub b.ok { color:var(--good); } .headline .sub b.warn { color:var(--warning); } .headline .sub b.bad { color:var(--critical); }
  .facts { display:flex; gap:28px; flex-wrap:wrap; }
  .fact { display:flex; flex-direction:column; gap:5px; }
  .fact .v { font:600 14px/1 var(--font-ui); display:flex; align-items:center; gap:6px; white-space:nowrap; }
  .fact .v small { font:var(--t3); color:var(--text-muted); font-weight:400; }
  .stamp { text-align:right; font:var(--t3); color:var(--text-muted); line-height:1.5; }
  .stamp b { color:var(--text-secondary); font-weight:500; }

  /* layout + sections */
  .cols { display:grid; grid-template-columns:minmax(0,1fr) 340px; column-gap:36px; }
  .col-main { min-width:0; }
  .col-rail { min-width:0; border-left:1px solid var(--hair); padding-left:28px; }
  .rsec { padding:18px 0 4px; }
  .rsec + .rsec { border-top:1px solid var(--hair); margin-top:14px; }
  .sh { display:flex; align-items:baseline; gap:10px; margin-bottom:10px; flex-wrap:wrap; }
  .sh .lbl { color:var(--text-secondary); }
  .sh .note { font:var(--t3); color:var(--text-muted); }
  .nar { margin:0; font:var(--t3); font-size:12px; line-height:1.55; color:var(--text-secondary); white-space:pre-wrap; }
  .nar.auto { color:var(--text-muted); white-space:normal; }
  .nars .nar + .nar { margin-top:9px; }
  .narrow-only { display:none; }
  .foot { font:var(--t3); color:var(--text-muted); margin:28px 0 0; padding-top:12px; border-top:1px solid var(--hair); }

  /* ledger tables */
  .ledger { border-top:1px solid var(--hair-strong); }
  .ledger .row { display:grid; align-items:center; column-gap:18px; padding:9px 10px 9px 14px; border-bottom:1px solid var(--hair); box-shadow:inset 3px 0 0 var(--tick, transparent); }
  .ledger .hdr { padding-top:7px; padding-bottom:7px; box-shadow:none; }
  .ledger .hdr span { white-space:nowrap; font:var(--label); letter-spacing:.06em; text-transform:uppercase; color:var(--text-muted); }
  .ledger .r { text-align:right; }
  .ledger .name { min-width:0; }
  .ledger .name b { font-weight:600; }
  .ledger .name small { display:block; font:var(--t3); color:var(--text-muted); margin-top:2px; }
  .ledger .sub { font:var(--t3); color:var(--text-muted); }
  .ledger .num { font:var(--t2-num); white-space:nowrap; text-align:right; }
  .ledger .num small { font:var(--t3); color:var(--text-muted); font-weight:400; }
  .ledger .num small.ph { display:none; }
  .ledger .det { font:var(--t3); font-size:12px; color:var(--text-secondary); }
  .pill { font:700 10.5px/1 var(--font-ui); letter-spacing:.06em; text-transform:uppercase; color:var(--tick, var(--text-muted)); white-space:nowrap; }
  .ledger.pw .row { grid-template-columns:minmax(0,1.6fr) minmax(0,1fr) 120px; }
  .ledger.wl .row { grid-template-columns:minmax(150px,1.2fr) 84px minmax(170px,1.6fr) 74px 84px; }
  .ledger.ins .row { grid-template-columns:minmax(120px,1fr) 110px 150px 80px 100px; }
  .ledger.dr .row { grid-template-columns:minmax(150px,1fr) minmax(160px,1.5fr) 130px 76px; }
  .ledger.dr .row[data-status=warning], .ledger.th .row[data-status=warning] { background:var(--warning-bg); }
  .ledger.th .row { grid-template-columns:110px minmax(0,1fr) 170px; align-items:start; }

  /* watchlist rail: price against the wave targets */
  .wrail { position:relative; height:26px; }
  .wrail .ln { position:absolute; left:0; right:0; top:9px; height:3px; border-radius:2px; background:var(--sunk);
    background-image:linear-gradient(90deg, color-mix(in srgb, var(--good) 30%, transparent) 0 var(--w1), transparent var(--w1)); }
  .wrail .tk { position:absolute; top:5px; width:1px; height:11px; background:var(--text-muted); }
  .wrail .tl { position:absolute; top:17px; transform:translateX(-50%); font:500 9.5px/1 var(--font-ui); color:var(--text-muted); white-space:nowrap; }
  .wrail .dot { position:absolute; top:6px; width:9px; height:9px; margin-left:-4.5px; border-radius:50%; background:var(--text-primary); box-shadow:0 0 0 2.5px var(--page); }
  .wrail .dot[data-status=good] { background:var(--good); } .wrail .dot[data-status=warning] { background:var(--warning); }

  /* drift */
  .grp { font:600 12px/1 var(--font-ui); color:var(--text-primary); padding:14px 0 8px; display:flex; justify-content:space-between; }
  .grp small { font:var(--t3); color:var(--text-muted); font-weight:400; }
  .dbar { position:relative; height:6px; border-radius:3px; background:var(--sunk); }
  .dbar .f { position:absolute; left:0; top:0; bottom:0; border-radius:3px; background:color-mix(in srgb, var(--text-primary) 45%, transparent); }
  .dbar .f[data-status=warning] { background:var(--warning); }
  .dbar .t { position:absolute; top:-4px; bottom:-4px; width:2px; margin-left:-1px; background:var(--accent); border-radius:1px; }
  .flagnote { margin-top:10px; padding:10px 12px; border-left:3px solid var(--warning); background:var(--warning-bg); font:var(--t3); font-size:12px; color:var(--text-secondary); line-height:1.5; }
  .flagnote b { color:var(--text-primary); }

  /* criteria / trigger lists */
  .dtype { font:600 17px/1.25 var(--font-ui); margin:0 0 6px; }
  .crit { list-style:none; margin:0; padding:0; }
  .crit li { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:4px 12px; padding:9px 0; border-bottom:1px solid var(--hair); }
  .crit li b { font:600 12.5px/1.3 var(--font-ui); }
  .crit li .pill { align-self:start; padding-top:2px; }
  .crit li .d { grid-column:1 / -1; font:var(--t3); font-size:12px; color:var(--text-secondary); }

  /* thesis */
  .chip { display:inline-block; text-align:left; font:500 11px/1.35 var(--font-ui); padding:4px 8px; border-radius:4px; background:var(--sunk); box-shadow:inset 0 0 0 1px var(--hair-strong); }
  .verd { font:600 13px/1.35 var(--font-ui); }
  .why { font:var(--t3); font-size:12px; line-height:1.5; color:var(--text-secondary); margin-top:3px; }

  @media (max-width: 1180px) {
    .cols { grid-template-columns:minmax(0,1fr); }
    .col-rail { border-left:0; padding-left:0; border-top:1px solid var(--hair); margin-top:14px; }
    .verdict { grid-template-columns:minmax(0,1fr); gap:14px; }
    .stamp { text-align:left; }
    .narrow-only { display:block; }
    .wide-only { display:none; }
  }
  @media (max-width: 640px) {
    .wrap { padding:0 14px 28px; }
    .topbar { display:flex; flex-wrap:wrap; height:auto; gap:0; padding-top:10px; }
    .brand { order:1; padding-bottom:8px; }
    .tab-bar { order:2; width:100%; display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); margin:0 0 10px; }
    .topright { order:3; margin-left:auto; padding-bottom:8px; }
    .verdict { padding:16px 0 14px; gap:12px; }
    .headline { flex-direction:column; align-items:flex-start; gap:6px; }
    .headline .big { font-size:30px; } .headline .big.long { font-size:20px; }
    .facts { display:grid; grid-template-columns:1fr 1fr; gap:12px 16px; }
    .fact .v { flex-wrap:wrap; line-height:1.3; white-space:normal; }
    .ledger .hdr { display:none; }
    .ledger.pw .row { grid-template-columns:minmax(0,1fr) auto; row-gap:4px; } .ledger.pw .row .det { grid-column:1 / -1; order:5; }
    .ledger.wl .row { grid-template-columns:minmax(0,1fr) auto auto; row-gap:8px; } .ledger.wl .row .railc { grid-column:1 / -1; order:5; } .ledger.wl .row .vs { display:none; }
    .ledger.ins .row { grid-template-columns:minmax(0,1fr) auto auto auto; column-gap:12px; } .ledger.ins .row .dt { display:none; }
    .ledger .num small.ph { display:inline; }
    .ledger.dr .row { grid-template-columns:minmax(0,1fr) auto auto; row-gap:6px; } .ledger.dr .row .barc { grid-column:1 / -1; order:5; }
    .ledger.th .row { grid-template-columns:minmax(0,1fr) auto; row-gap:6px; } .ledger.th .row .body { grid-column:1 / -1; order:5; }
  }
`;
