import { supabase } from "./supabase.js";

// Market positioning panel (added 2026-10-29): are big players positioned
// for or against the market? Three free sources, ingested by
// ingestion/src/sources/{cftc,cboe,finra}.ts:
//   - CFTC Traders in Financial Futures: net position as % of open interest
//     (weekly, Tuesday positions published Friday)
//   - CBOE equity put/call ratio, as a 10-trading-day average (daily)
//   - FINRA margin debt, as year-over-year growth (monthly, ~3-4 week lag)
//
// Each measure is placed against its own history as a percentile, since
// the raw levels mean little alone (e.g. leveraged funds are structurally
// net short S&P futures because much of it hedges long stock). Extremes
// (>=90th / <=10th) get a plain-language read; the 90/10 cutoffs are a
// first cut, not backtested. Informational only -- never part of the
// 3-of-6 wave-authorization gate.
//
// dashboard_site/index.html mirrors POSITIONING_MEASURES and this math
// (duplicated, not shared across the package boundary -- same convention as
// sectorRotation.ts). Change both together.

type MeasureKind = "cot_weekly" | "put_call_10d" | "margin_yoy";

interface MeasureDef {
  key: string;
  seriesId: string;
  label: string;
  kind: MeasureKind;
  unit: string;
  highRead: string;
  lowRead: string;
}

export const POSITIONING_MEASURES: MeasureDef[] = [
  {
    key: "sp500_asset_managers_net",
    seriesId: "COT_ES_ASSET_MGR_NET_PCT_OI",
    label: "S&P 500 futures: asset managers net",
    kind: "cot_weekly",
    unit: "pct_open_interest",
    highRead: "crowded long -- little fresh buying left, more fuel for a selloff",
    lowRead: "unusually light long -- room to add exposure",
  },
  {
    key: "sp500_leveraged_funds_net",
    seriesId: "COT_ES_LEV_FUNDS_NET_PCT_OI",
    label: "S&P 500 futures: hedge funds net",
    kind: "cot_weekly",
    unit: "pct_open_interest",
    highRead: "unusually long -- hedge funds leaning bullish",
    lowRead: "unusually short -- heavy hedging or bearish bets (can fuel a short-covering rally)",
  },
  {
    key: "vix_leveraged_funds_net",
    seriesId: "COT_VIX_LEV_FUNDS_NET_PCT_OI",
    label: "VIX futures: hedge funds net",
    kind: "cot_weekly",
    unit: "pct_open_interest",
    highRead: "long volatility -- hedge funds paying for protection",
    lowRead: "heavily short volatility -- complacency, vulnerable to a vol spike",
  },
  {
    key: "treasury_10y_leveraged_funds_net",
    seriesId: "COT_TY_LEV_FUNDS_NET_PCT_OI",
    label: "10y Treasury futures: hedge funds net",
    kind: "cot_weekly",
    unit: "pct_open_interest",
    highRead: "unusually long",
    lowRead: "unusually short -- mostly the cash-futures basis trade; crowding here was the 2020 'dash for cash' unwind risk",
  },
  {
    key: "equity_put_call_10d",
    seriesId: "CBOE_EQUITY_PC_RATIO",
    label: "Equity put/call ratio (10-day avg)",
    kind: "put_call_10d",
    unit: "ratio",
    highRead: "fearful -- heavy put buying (historically a contrarian positive)",
    lowRead: "complacent -- heavy call buying",
  },
  {
    key: "margin_debt_yoy",
    seriesId: "FINRA_MARGIN_DEBIT_USD_MILLIONS",
    label: "Margin debt, year-over-year",
    kind: "margin_yoy",
    unit: "pct_yoy",
    highRead: "leverage surging -- fast growth preceded the 2000, 2007 and 2021 tops",
    lowRead: "deleveraging -- forced selling usually already under way",
  },
];

const PERCENTILE_YEARS = 5; // COT and put/call; margin YoY uses its full history (only 12 points/yr)
const EXTREME_HIGH = 90;
const EXTREME_LOW = 10;

export interface PositioningMeasure {
  key: string;
  label: string;
  value: number;
  unit: string;
  as_of: string;
  percentile: number;
  percentile_window: string;
  window_min: number;
  window_max: number;
  change_1m: number | null;
  extreme: "high" | "low" | null;
  read: string;
  margin_debt_usd_millions?: number;
}

interface Point {
  date: string;
  value: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function yearsBefore(dateStr: string, years: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d.toISOString().slice(0, 10);
}

// PostgREST caps responses at 1000 rows -- 5yr of daily put/call is ~1,260,
// so paginate (same reason as sectorRotation.ts's fetchAllDataPoints).
async function fetchSeries(seriesIds: string[], sinceDate: string): Promise<Map<string, Point[]>> {
  const pageSize = 1000;
  const bySeries = new Map<string, Point[]>(seriesIds.map((id) => [id, []]));
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await supabase
      .from("data_points")
      .select("series_id, observation_date, value")
      .in("series_id", seriesIds)
      .gte("observation_date", sinceDate)
      .order("observation_date", { ascending: true })
      .order("series_id", { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (error) {
      throw new Error(`Failed to read positioning data_points: ${error.message}`);
    }
    for (const row of data ?? []) {
      bySeries.get(row.series_id)?.push({ date: row.observation_date, value: row.value });
    }
    if ((data ?? []).length < pageSize) break;
  }
  return bySeries;
}

/** The series each measure is actually read on, oldest first. */
function derivedSeries(kind: MeasureKind, raw: Point[]): Point[] {
  if (kind === "put_call_10d") {
    const out: Point[] = [];
    for (let i = 9; i < raw.length; i++) {
      const window = raw.slice(i - 9, i + 1);
      out.push({ date: raw[i].date, value: window.reduce((s, p) => s + p.value, 0) / 10 });
    }
    return out;
  }
  if (kind === "margin_yoy") {
    // Matched by calendar month, not array offset -- robust to a missing month.
    const byMonth = new Map(raw.map((p) => [p.date.slice(0, 7), p.value]));
    const out: Point[] = [];
    for (const p of raw) {
      const priorMonth = `${Number(p.date.slice(0, 4)) - 1}${p.date.slice(4, 7)}`;
      const prior = byMonth.get(priorMonth);
      if (prior) out.push({ date: p.date, value: ((p.value - prior) / prior) * 100 });
    }
    return out;
  }
  return raw;
}

// How many points back is "about a month" for each cadence.
const ONE_MONTH_BACK: Record<MeasureKind, number> = { cot_weekly: 4, put_call_10d: 21, margin_yoy: 1 };

export function computeMeasure(def: MeasureDef, raw: Point[]): PositioningMeasure | null {
  const series = derivedSeries(def.kind, raw);
  const latest = series.at(-1);
  if (!latest) return null;

  const fullHistory = def.kind === "margin_yoy";
  const windowStart = fullHistory ? "" : yearsBefore(latest.date, PERCENTILE_YEARS);
  const window = series.filter((p) => p.date >= windowStart).map((p) => p.value);
  const percentile = Math.round((window.filter((v) => v <= latest.value).length / window.length) * 100);
  const monthAgo = series.at(-1 - ONE_MONTH_BACK[def.kind]);
  const extreme = percentile >= EXTREME_HIGH ? "high" : percentile <= EXTREME_LOW ? "low" : null;

  return {
    key: def.key,
    label: def.label,
    value: round2(latest.value),
    unit: def.unit,
    as_of: latest.date,
    percentile,
    percentile_window: fullHistory ? `full history since ${series[0].date.slice(0, 4)}` : `trailing ${PERCENTILE_YEARS}y`,
    window_min: round2(Math.min(...window)),
    window_max: round2(Math.max(...window)),
    change_1m: monthAgo ? round2(latest.value - monthAgo.value) : null,
    extreme,
    read: extreme === "high" ? def.highRead : extreme === "low" ? def.lowRead : "within its normal range",
    ...(def.kind === "margin_yoy" ? { margin_debt_usd_millions: raw.at(-1)!.value } : {}),
  };
}

export async function computeMarketPositioning(): Promise<PositioningMeasure[]> {
  const today = new Date().toISOString().slice(0, 10);
  // COT/put-call need 5y plus lead-in for the 10-day average and 1-month
  // change; margin needs its full history (YoY percentile is full-window).
  const shortWindowIds = POSITIONING_MEASURES.filter((m) => m.kind !== "margin_yoy").map((m) => m.seriesId);
  const marginIds = POSITIONING_MEASURES.filter((m) => m.kind === "margin_yoy").map((m) => m.seriesId);
  const [recent, margin] = await Promise.all([
    fetchSeries(shortWindowIds, yearsBefore(today, PERCENTILE_YEARS + 1)),
    fetchSeries(marginIds, "1990-01-01"),
  ]);

  return POSITIONING_MEASURES.map((def) => computeMeasure(def, (recent.get(def.seriesId) ?? margin.get(def.seriesId)) ?? [])).filter(
    (m): m is PositioningMeasure => m !== null,
  );
}
