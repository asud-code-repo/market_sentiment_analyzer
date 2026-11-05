// Role-fit metrics for deployment instruments — REPORT-ONLY (decided
// 2026-11-05: compute and show readings for one quarter, set bands at the
// 2027-02-02 review). Nothing here grades readiness or recommends a swap.
//
// "Role fit" = does the instrument still behave the way its slot assumes
// (correlation to its benchmark, beta to SPY, volatility, tracking,
// breakeven sensitivity for TIPS, behavior in past SPY drawdowns). Returns
// are deliberately not a metric. Pure functions; data comes from
// roleFitData.ts.

import { deref, type Registry, type RoleFitSpec } from "./instruments.js";

export type PriceSeries = Map<string, number>; // YYYY-MM-DD -> adjusted close

const WINDOW = 252;

// --- Math ---------------------------------------------------------------------

function sortedDates(s: PriceSeries): string[] {
  return [...s.keys()].sort();
}

/** Daily simple returns keyed by the later date. */
export function dailyReturns(s: PriceSeries): Map<string, number> {
  const d = sortedDates(s);
  const out = new Map<string, number>();
  for (let i = 1; i < d.length; i++) {
    const p0 = s.get(d[i - 1])!;
    const p1 = s.get(d[i])!;
    if (p0 > 0) out.set(d[i], p1 / p0 - 1);
  }
  return out;
}

/** Daily-rebalanced blend of component returns (dates where all exist). */
export function blendReturns(components: { r: Map<string, number>; w: number }[]): Map<string, number> {
  const out = new Map<string, number>();
  if (!components.length) return out;
  const total = components.reduce((a, c) => a + c.w, 0);
  for (const date of components[0].r.keys()) {
    let v = 0;
    let ok = true;
    for (const c of components) {
      const x = c.r.get(date);
      if (x === undefined) {
        ok = false;
        break;
      }
      v += (c.w / total) * x;
    }
    if (ok) out.set(date, v);
  }
  return out;
}

/** Last `n` dates present in both, oldest first. */
export function align(a: Map<string, number>, b: Map<string, number>, n = WINDOW): [number[], number[]] {
  const dates = [...a.keys()].filter((d) => b.has(d)).sort().slice(-n);
  return [dates.map((d) => a.get(d)!), dates.map((d) => b.get(d)!)];
}

function mean(x: number[]): number {
  return x.reduce((a, v) => a + v, 0) / x.length;
}

export function correlation(x: number[], y: number[]): number | null {
  if (x.length < 30) return null;
  const mx = mean(x);
  const my = mean(y);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < x.length; i++) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) ** 2;
    syy += (y[i] - my) ** 2;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}

/** Slope of y on x. */
export function beta(y: number[], x: number[]): number | null {
  if (x.length < 30) return null;
  const mx = mean(x);
  const my = mean(y);
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < x.length; i++) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) ** 2;
  }
  return sxx > 0 ? sxy / sxx : null;
}

export function annualizedVolPct(r: number[]): number | null {
  if (r.length < 30) return null;
  const m = mean(r);
  const v = r.reduce((a, x) => a + (x - m) ** 2, 0) / (r.length - 1);
  return Math.sqrt(v * 252) * 100;
}

function compound(r: Map<string, number>, from: string, to: string): number | null {
  const ds = [...r.keys()].filter((d) => d > from && d <= to);
  if (!ds.length) return null;
  return (ds.reduce((a, d) => a * (1 + r.get(d)!), 1) - 1) * 100;
}

/** SPY drawdown episodes of at least `minPct` (peak -> trough). */
export function drawdownEpisodes(s: PriceSeries, minPct = 10): { peak: string; trough: string; depth_pct: number }[] {
  const d = sortedDates(s);
  const out: { peak: string; trough: string; depth_pct: number }[] = [];
  let peakDate = d[0];
  let peak = s.get(d[0]) ?? 0;
  let trough = { date: d[0], value: peak };
  for (const date of d.slice(1)) {
    const v = s.get(date)!;
    if (v >= peak) {
      const depth = (1 - trough.value / peak) * 100;
      if (depth >= minPct) out.push({ peak: peakDate, trough: trough.date, depth_pct: round1(depth) });
      peak = v;
      peakDate = date;
      trough = { date, value: v };
    } else if (v < trough.value) {
      trough = { date, value: v };
    }
  }
  const depth = (1 - trough.value / peak) * 100;
  if (depth >= minPct) out.push({ peak: peakDate, trough: trough.date, depth_pct: round1(depth) }); // still open
  return out;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;
const r2 = (n: number | null) => (n === null ? null : round2(n));

// --- Per-slot report ------------------------------------------------------------

export interface InstrumentFit {
  which: "primary" | "backup";
  name: string;
  price_ticker: string | null;
  proxy: boolean;
  metrics: Record<string, number | null> | null;
  stress_episodes?: { peak: string; trough: string; spy_pct: number | null; instrument_pct: number | null; benchmark_pct: number | null }[];
  note?: string;
}

export interface SlotFit {
  slot: string;
  role: string;
  benchmark: RoleFitSpec["benchmark"] | null;
  proposed_bands_not_adopted: Record<string, string> | null;
  instruments: InstrumentFit[];
  manual_only?: string;
}

export function priceTickerOf(inst: { ticker?: string | null; proxy_ticker?: string | null }): { t: string | null; proxy: boolean } {
  if (inst.ticker) return { t: inst.ticker.toUpperCase(), proxy: false };
  if (inst.proxy_ticker) return { t: inst.proxy_ticker.toUpperCase(), proxy: true };
  return { t: null, proxy: false };
}

/** Every ticker the role-fit report needs prices for. */
export function tickersNeeded(reg: Registry): string[] {
  const out = new Set<string>(["SPY"]);
  for (const slot of Object.values(reg.slots)) {
    const spec = slot.role_fit;
    if (!spec || spec.manual_only) continue;
    if (typeof spec.benchmark === "string") out.add(spec.benchmark.toUpperCase());
    else if (spec.benchmark) for (const t of Object.keys(spec.benchmark)) out.add(t.toUpperCase());
    if (spec.compare_to) out.add(spec.compare_to.toUpperCase());
    for (const which of ["primary", "backup"] as const) {
      const t = priceTickerOf(deref(slot[which], reg)).t;
      if (t) out.add(t);
    }
  }
  return [...out];
}

export function computeRoleFit(
  reg: Registry,
  prices: Map<string, PriceSeries>,
  breakevens: Map<string, PriceSeries>,
): SlotFit[] {
  const rets = new Map<string, Map<string, number>>();
  const ret = (t: string) => {
    if (!rets.has(t)) {
      const p = prices.get(t);
      rets.set(t, p ? dailyReturns(p) : new Map());
    }
    return rets.get(t)!;
  };
  const spy = ret("SPY");
  const spyPrices = prices.get("SPY");
  const episodes = spyPrices ? drawdownEpisodes(spyPrices) : [];
  const out: SlotFit[] = [];

  for (const [id, slot] of Object.entries(reg.slots)) {
    const spec = slot.role_fit;
    if (!spec) continue;
    const fit: SlotFit = {
      slot: id,
      role: slot.role,
      benchmark: spec.benchmark ?? null,
      proposed_bands_not_adopted: spec.proposed_bands ?? null,
      instruments: [],
    };
    if (spec.manual_only) {
      fit.manual_only = spec.manual_only;
      out.push(fit);
      continue;
    }
    const bench: Map<string, number> | null =
      typeof spec.benchmark === "string"
        ? ret(spec.benchmark.toUpperCase())
        : spec.benchmark
          ? blendReturns(Object.entries(spec.benchmark).map(([t, w]) => ({ r: ret(t.toUpperCase()), w })))
          : null;
    const cmp = spec.compare_to ? ret(spec.compare_to.toUpperCase()) : null;
    const be = spec.breakeven_series ? breakevens.get(spec.breakeven_series) : undefined;
    const beChange = be ? dailyLevelChanges(be) : null;

    for (const which of ["primary", "backup"] as const) {
      const inst = deref(slot[which], reg);
      const { t, proxy } = priceTickerOf(inst);
      const base: InstrumentFit = { which, name: inst.plan_name ?? inst.name, price_ticker: t, proxy, metrics: null };
      if (!t || !prices.get(t)?.size) {
        fit.instruments.push({ ...base, note: t ? `no price data for ${t}` : "no public price — manual check" });
        continue;
      }
      const r = ret(t);
      const m: Record<string, number | null> = {};
      const [yS, xS] = align(r, spy);
      m.beta_spy = r2(beta(yS, xS));
      m.ann_vol_pct = r2(annualizedVolPct(align(r, r)[0]));
      if (bench && bench.size) {
        const [y, x] = align(r, bench);
        m.corr_benchmark = r2(correlation(y, x));
        const [y30, x30] = align(r, bench, 30);
        m.return_gap_30d_pts =
          y30.length === 30 ? r2((y30.reduce((a, v) => a * (1 + v), 1) - x30.reduce((a, v) => a * (1 + v), 1)) * 100) : null;
      }
      if (cmp && cmp.size) m.corr_compare = r2(correlation(...align(r, cmp)));
      if (beChange && beChange.size) {
        const [y, x] = align(r, beChange);
        const b = beta(y, x); // return per 1.00 pt breakeven change
        m.breakeven_corr = r2(correlation(y, x));
        m.breakeven_beta_pct_per_10bp = b === null ? null : r2(b * 0.1 * 100);
      }
      const stress = episodes.map((e) => ({
        peak: e.peak,
        trough: e.trough,
        spy_pct: r2(compound(spy, e.peak, e.trough)),
        instrument_pct: r2(compound(r, e.peak, e.trough)),
        benchmark_pct: bench ? r2(compound(bench, e.peak, e.trough)) : null,
      }));
      fit.instruments.push({ ...base, metrics: m, stress_episodes: stress.filter((s) => s.instrument_pct !== null) });
    }
    out.push(fit);
  }
  return out;
}

/** Day-over-day level change (e.g. breakeven in percentage points). */
export function dailyLevelChanges(s: PriceSeries): Map<string, number> {
  const d = sortedDates(s);
  const out = new Map<string, number>();
  for (let i = 1; i < d.length; i++) out.set(d[i], s.get(d[i])! - s.get(d[i - 1])!);
  return out;
}
