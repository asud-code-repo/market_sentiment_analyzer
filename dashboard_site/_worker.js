// Cloudflare Pages "advanced mode" worker (2026-11-15).
//
// Why: the page loads its data in the browser, so search crawlers and AI
// tools that read HTML without running JavaScript only saw "Loading…".
// This worker puts the latest reading into the HTML they receive and serves
// the same reading as plain text at /latest.md. Browsers get the same page
// as before; the client-side render replaces the inserted headline.
//
// Scope: _routes.json sends only "/" and "/latest.md" here; every other file
// is served as a plain static asset. It lives in dashboard_site (the Pages
// output folder) because the project has no root dir, so a functions/ folder
// would have to sit at the repo root.
//
// Fail-safe: any error or slow response from Supabase returns the untouched
// static page (or a 503 for /latest.md); this must never break the site.
//
// Reads only the public crash_checks table with the same publishable key the
// page already ships (protected by RLS + GRANT, not secrecy).

const SUPABASE_URL = "https://jophlgbijfahmytkrjly.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_DAU2BkfrG_3-LU_fFKW1og_yVasDG6d";
const SITE = "https://marketstress.org";
const CACHE_SECONDS = 600;
const CACHE_KEY = `${SITE}/__cache/latest-reading-v1`;
const FETCH_TIMEOUT_MS = 2000;

const LATEST_FIELDS = "run_at,vix_value,vix_color,hy_spread_bps,hy_spread_color,sp_drawdown_pct,sp_drawdown_color,treasury_10y_pct,treasury_10y_color,sahm_rule_value,sahm_rule_color,fed_pivot_signal,fed_pivot_color,red_count,confirmed_red_count,confirmation_state,wave_authorized,warsh_classification,dd_vix_band,crash_probability_pct";

// Same order, labels and formats as GATE_ROWS in index.html.
const INDICATORS = [
  { name: "VIX", short: "VIX", v: "vix_value", c: "vix_color", conf: "vix", fmt: (v) => v.toFixed(2) },
  { name: "High-yield credit spread", short: "high-yield spread", v: "hy_spread_bps", c: "hy_spread_color", conf: "hy_spread", fmt: (v) => `${Math.round(v)} bp` },
  { name: "S&P 500 drawdown from all-time high", short: "S&P 500 drawdown", v: "sp_drawdown_pct", c: "sp_drawdown_color", conf: "sp_drawdown", fmt: (v) => `${v.toFixed(2)}%` },
  { name: "10-year Treasury yield", short: "10-year Treasury yield", v: "treasury_10y_pct", c: "treasury_10y_color", conf: "treasury_10y", fmt: (v) => `${v.toFixed(2)}%` },
  { name: "Sahm rule", short: "Sahm rule", v: "sahm_rule_value", c: "sahm_rule_color", conf: "sahm_rule", fmt: (v) => v.toFixed(2) },
  { name: "Fed pivot signal", short: "Fed pivot signal", v: "fed_pivot_signal", c: "fed_pivot_color", conf: null, fmt: (v) => (v === "NONE" ? "none" : String(v).toLowerCase()) },
];
// Copied from index.html (DD_VIX_BAND_LABELS / DD_VIX_HIT_RATE / ddVixReading).
const DD_VIX_BAND_LABELS = { LOW: "Low", TRANSITIONING: "Elevated", HIGH: "High" };
const DD_VIX_HIT_RATE = { LOW: "5%", TRANSITIONING: "17%", HIGH: "44%" };
function ddVixReading(row) {
  const dd = row.sp_drawdown_pct == null ? null : Number(row.sp_drawdown_pct);
  if (dd != null && dd >= 10) return { status: "ALREADY_BREACHED", band: null };
  if (row.dd_vix_band) return { status: "ELIGIBLE", band: row.dd_vix_band };
  const vix = row.vix_value == null ? null : Number(row.vix_value);
  if (dd == null || vix == null) return { status: "UNAVAILABLE", band: null };
  const score = dd + vix / 5;
  return { status: "ELIGIBLE", band: score >= 10 ? "HIGH" : score >= 8.5 ? "TRANSITIONING" : "LOW" };
}
const RUN_LABEL = /^\s*Full report(?:\s*\([^)]*\)|,[^.]*)\.\s+/i;
const DISCLAIMER = "For information only, not investment advice. A personal project: signals apply the author's own rules, plus some AI judgment, to public data. They are not recommendations or calibrated forecasts, and data can be delayed or wrong.";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/latest.md") return latestMarkdown(request, ctx);
    if (url.pathname !== "/" || request.method !== "GET") return env.ASSETS.fetch(request);

    // Fetch by URL only, so a browser's If-None-Match can't turn this into a
    // bodyless 304 for a page whose inserted text has since changed.
    const asset = await env.ASSETS.fetch(new Request(url.toString()));
    if (!asset.ok || !(asset.headers.get("content-type") || "").includes("text/html")) return asset;
    let data;
    try { data = await loadLatest(ctx); } catch (e) { return asset; }
    if (!data) return asset;

    const headers = new Headers(asset.headers);
    headers.delete("etag");
    headers.delete("content-length");
    headers.set("cache-control", "public, max-age=0, must-revalidate");
    return new HTMLRewriter()
      .on("#stress-verdict", { element(el) { el.setInnerContent(verdictHtml(data), { html: true }); } })
      .on("#site-summary", { element(el) { el.append(` ${escHtml(summarySentence(data))}`, { html: true }); } })
      .transform(new Response(asset.body, { status: asset.status, headers }));
  },
};

async function latestMarkdown(request, ctx) {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
  let data = null;
  try { data = await loadLatest(ctx); } catch (e) { data = null; }
  if (!data) {
    return new Response(`# Market Stress Monitor\n\nThe latest reading is temporarily unavailable. See ${SITE}/\n`, {
      status: 503, headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-store", "retry-after": "300" },
    });
  }
  return new Response(request.method === "HEAD" ? null : markdown(data), {
    headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": `public, max-age=${CACHE_SECONDS}`, link: `<${SITE}/>; rel="canonical"` },
  });
}

// ---- Data -----------------------------------------------------------------

async function loadLatest(ctx) {
  const cache = caches.default;
  const hit = await cache.match(CACHE_KEY);
  if (hit) return hit.json();
  const since = new Date(Date.now() - CONTEXT_LOOKBACK_DAYS * 86400000).toISOString().slice(0, 10);
  const [latest, full, context] = await Promise.all([
    supabase(`crash_checks?select=${LATEST_FIELDS}&order=run_at.desc&limit=1`),
    supabase("crash_checks?select=run_at,notes,scenario_method,scenario_prior_state,scenario_tilt,scenario_bear_pct,scenario_crash_pct&notes=not.is.null&order=run_at.desc&limit=1"),
    // Context is optional: a failure here must not take down the reading.
    supabase(`data_points?select=series_id,observation_date,value&series_id=in.(${CONTEXT_SERIES.join(",")})&observation_date=gte.${since}&order=observation_date.desc`).catch(() => []),
  ]);
  if (!latest[0]) return null;
  const ctxLatest = {};
  for (const r of context) if (!(r.series_id in ctxLatest)) ctxLatest[r.series_id] = r;
  const data = { row: latest[0], full: full[0] ?? null, context: ctxLatest };
  ctx.waitUntil(cache.put(CACHE_KEY, new Response(JSON.stringify(data), {
    headers: { "content-type": "application/json", "cache-control": `public, max-age=${CACHE_SECONDS}` },
  })));
  return data;
}

async function supabase(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_ANON_KEY, authorization: `Bearer ${SUPABASE_ANON_KEY}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Supabase HTTP ${res.status}`);
  return res.json();
}

// ---- Context beyond the gate ---------------------------------------------

// Financial-plumbing context shown on the page's Macro & Fiscal tab (no
// traffic light, not in the gate). Listed here so AI tools reading
// /latest.md see that the site covers more than the six gate indicators.
// Signal wording mirrors CONTEXT_INFO in index.html; change them together.
const CONTEXT_SERIES = ["OFR_FSI", "STLFSI4", "NFCI", "SOFR", "IORB", "DTWEXBGS"];
const CONTEXT_LOOKBACK_DAYS = 45;

function contextLines(ctx) {
  if (!ctx) return [];
  const v = (id) => ctx[id]?.value;
  const d = (id) => ctx[id]?.observation_date;
  const above = (x, hi, lo) => (x > 0 ? hi : lo);
  const out = [];
  if (v("OFR_FSI") != null) out.push(`| OFR Financial Stress Index (US Treasury; credit, funding, volatility, valuation, US and abroad) | ${v("OFR_FSI").toFixed(2)} | ${above(v("OFR_FSI"), "above-average stress", "below-average stress")} (0 = average) | ${d("OFR_FSI")} |`);
  if (v("STLFSI4") != null) out.push(`| St. Louis Fed Financial Stress Index | ${v("STLFSI4").toFixed(2)} | ${above(v("STLFSI4"), "above-average stress", "below-average stress")} (0 = average) | ${d("STLFSI4")} |`);
  if (v("NFCI") != null) out.push(`| Chicago Fed National Financial Conditions Index | ${v("NFCI").toFixed(2)} | ${above(v("NFCI"), "tighter than average", "looser than average")} (0 = average) | ${d("NFCI")} |`);
  if (v("SOFR") != null) {
    const gap = v("IORB") != null ? Math.round((v("SOFR") - v("IORB")) * 100) : null;
    out.push(`| SOFR overnight repo rate | ${v("SOFR").toFixed(2)}% | ${gap == null ? "repo-market funding cost" : `${gap >= 0 ? "+" : ""}${gap} bp vs the Fed's interest on reserves (${v("IORB").toFixed(2)}%); a sustained gap above it signals a cash squeeze`} | ${d("SOFR")} |`);
  }
  if (v("DTWEXBGS") != null) out.push(`| Broad trade-weighted US dollar index | ${v("DTWEXBGS").toFixed(2)} | a fast rise tightens conditions for foreign dollar borrowers | ${d("DTWEXBGS")} |`);
  if (!out.length) return [];
  return [
    "",
    "## Context beyond the gate",
    "",
    "Shown on the page's Macro & Fiscal tab with no traffic light; they don't count toward the stress gate. The tab also has the fiscal-dominance checklist, the yield curve, Fed balance-sheet liquidity, credit-card delinquencies and breadth; the Smart Money tab has positioning percentiles (CFTC, CBOE put/call, FINRA margin debt) and 13F net buying.",
    "",
    "| Indicator | Value | Reading | Data date |",
    "|---|---|---|---|",
    ...out,
  ];
}

// ---- Shared facts ---------------------------------------------------------

const SCENARIO_PRIOR_FALL10 = { LOW: 8, TRANSITIONING: 8, HIGH: 19, ALREADY_BREACHED: 21 };

function facts({ row, full }) {
  const confirmed = row.confirmed_red_count ?? 0;
  const pending = Math.max(0, (row.red_count ?? 0) - confirmed);
  const indicators = INDICATORS.map((g) => {
    const value = row[g.v];
    const conf = g.conf ? row.confirmation_state?.[g.conf] : null;
    return {
      name: g.name,
      short: g.short,
      value: value == null ? "n/a" : (typeof value === "number" || g.conf === null ? g.fmt(value) : String(value)),
      color: row[g.c] ?? "n/a",
      pending: row[g.c] === "RED" && conf ? conf.confirmed === false : false,
      observed: conf?.observation_date ?? null,
    };
  });
  // LLM 3-month view: only tilt-based reports (2026-11-17 on); older splits had no defined horizon.
  const llm = full?.scenario_method === "tilt_v1" ? full : null;
  return { confirmed, pending, gateMet: !!row.wave_authorized, indicators, llm, asOf: row.run_at };
}

function fmtDate(iso, withTime) {
  const opts = { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric" };
  if (withTime) Object.assign(opts, { hour: "numeric", minute: "2-digit", timeZoneName: "short" });
  return new Date(iso).toLocaleString("en-US", opts);
}

function escHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---- HTML -----------------------------------------------------------------

// Mirrors the headline part of renderStressVerdict() in index.html, which
// replaces it once the page's JavaScript runs.
function verdictHtml(data) {
  const f = facts(data);
  const gate = f.gateMet ? '<b class="bad">Stress gate met</b>' : '<b class="ok">Stress gate not met</b>';
  return `<div class="headline"><div class="big">${f.confirmed}<em>/6</em> red</div>`
    + `<div class="sub">${gate} · gate needs 3 of 6 confirmed${f.pending ? ` · <b class="warn">${f.pending} pending</b>` : ""}</div></div>`
    + `<div class="facts"></div><div class="stamp"><b>As of ${escHtml(fmtDate(f.asOf, true))}</b></div>`;
}

// One plain sentence for the footer, e.g. "Latest reading (Nov 15, 2026):
// 0 of 6 confirmed RED, stress gate not met. RED: 10-year Treasury yield
// 5.10% (pending confirmation). GREEN: VIX 19.30, high-yield spread …"
function summarySentence(data) {
  const f = facts(data);
  const parts = [`Latest reading (${fmtDate(f.asOf, false)}): ${f.confirmed} of 6 confirmed RED, stress gate ${f.gateMet ? "met" : "not met"}.`];
  for (const color of ["RED", "AMBER", "GREEN"]) {
    const list = f.indicators.filter((i) => i.color === color)
      .map((i) => `${i.short} ${i.value}${i.pending ? " (pending confirmation)" : ""}`);
    if (list.length) parts.push(`${color}: ${list.join(", ")}.`);
  }
  return parts.join(" ");
}

// ---- Markdown -------------------------------------------------------------

function markdown(data) {
  const f = facts(data);
  const row = data.row;
  const lines = [
    "# Market Stress Monitor: latest reading",
    "",
    `As of ${fmtDate(f.asOf, true)}. Live page: ${SITE}/`,
    "",
    // Same schedule as STRESS_SCHEDULE in index.html; change them together.
    "Updates: data refresh around 10am ET (Mon-Sat) and 6pm ET (weekdays); daily written report around 6:30pm ET (weekdays). Times are approximate.",
    "",
    `**${f.confirmed} of 6 core indicators confirmed RED. Stress gate (3 of 6 confirmed) ${f.gateMet ? "met" : "not met"}.**${f.pending ? ` ${f.pending} RED reading${f.pending > 1 ? "s" : ""} pending confirmation.` : ""}`,
    "",
    "| Indicator | Value | Status | Data date |",
    "|---|---|---|---|",
    ...f.indicators.map((i) => `| ${i.name} | ${i.value} | ${i.color}${i.pending ? " (pending confirmation)" : ""} | ${i.observed ?? "manual judgment"} |`),
    "",
  ];
  const { status: bandStatus, band } = ddVixReading(row);
  if (bandStatus === "ALREADY_BREACHED") {
    lines.push("- Drawdown risk band: not scored (the S&P 500 is already more than 10% below its high).");
  } else if (band) {
    lines.push(`- Drawdown risk band (could a 10%+ S&P 500 drawdown begin within 21 trading days; from S&P drawdown and VIX): ${DD_VIX_BAND_LABELS[band] ?? band}. Historically, ${DD_VIX_HIT_RATE[band] ?? "an unknown share"} of days in this band were followed by such a drawdown, against 12% on a typical day.`);
  }
  if (row.warsh_classification) lines.push(`- Fed policy regime: ${row.warsh_classification.charAt(0)}${row.warsh_classification.slice(1).toLowerCase()}.`);
  if (f.llm) {
    // SCENARIO_PRIOR_FALL10: bear + crash of config/scenario_prior_v1.json "prior"; copied in index.html too.
    const hist = SCENARIO_PRIOR_FALL10[f.llm.scenario_prior_state];
    const tilt = { lower: "lower risk than", in_line: "in line with", higher: "higher risk than" }[f.llm.scenario_tilt] ?? f.llm.scenario_tilt;
    lines.push(`- AI view, next 3 months (${fmtDate(f.llm.run_at, false)}): ${tilt} history for this risk band. Chance of a 10%+ S&P 500 fall within 63 trading days: ${f.llm.scenario_bear_pct + f.llm.scenario_crash_pct}%${hist != null ? `, against ${hist}% for such days since 1990` : ""}. An AI judgment limited to one 5-point step from that history.`);
  }
  lines.push(...contextLines(data.context));
  const notes = data.full?.notes ? String(data.full.notes).replace(RUN_LABEL, "").trim() : "";
  if (notes) {
    lines.push("", `## Narrative (${fmtDate(data.full.run_at, false)})`, "", notes.replace(/\r\n/g, "\n"));
  }
  lines.push("", "---", "", DISCLAIMER, "", `Cite as: Market Stress Monitor, ${SITE}/, reading of ${fmtDate(f.asOf, false)}.`, "");
  return lines.join("\n");
}
