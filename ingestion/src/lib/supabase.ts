import { createClient } from "@supabase/supabase-js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

export const supabase = createClient(
  requireEnv("SUPABASE_URL"),
  requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
);

export interface DataPoint {
  series_id: string;
  source: string;
  source_series_code?: string;
  observation_date: string; // YYYY-MM-DD
  value: number;
  unit?: string;
  raw_payload?: unknown;
}

// Daily ingestion writes ~20 rows — irrelevant here — but backfill.ts can
// pass tens of thousands (5 years x ~17 FRED series), which risks hitting a
// request payload limit in one upsert call. Chunking keeps every caller safe
// without needing to know its own volume.
const UPSERT_CHUNK_SIZE = 500;

/**
 * Upserts on (series_id, observation_date) — see the unique constraint in
 * supabase/migrations/20260708000000_stage1_schema.sql. Safe to call
 * repeatedly with the same observation without duplicating rows.
 */
export async function writeDataPoints(points: DataPoint[]): Promise<void> {
  if (points.length === 0) return;

  for (let i = 0; i < points.length; i += UPSERT_CHUNK_SIZE) {
    const chunk = points.slice(i, i + UPSERT_CHUNK_SIZE);
    const { error } = await supabase
      .from("data_points")
      .upsert(chunk, { onConflict: "series_id,observation_date" });

    if (error) {
      throw new Error(`Supabase upsert failed for data_points (rows ${i}-${i + chunk.length}): ${error.message}`);
    }
  }
}

/**
 * Most recent known value for a series, or null if none exists yet. Used
 * by the plausibility guard (see lib/plausibility.ts) to compare an
 * incoming value against what's already on record before writing it.
 */
export async function getLatestValue(seriesId: string): Promise<number | null> {
  const { data, error } = await supabase
    .from("data_points")
    .select("value")
    .eq("series_id", seriesId)
    .order("observation_date", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to read latest value for ${seriesId}: ${error.message}`);
  }
  return data?.value ?? null;
}

export interface InsiderTransaction {
  ticker: string;
  issuer_cik: string;
  accession_number: string;
  line_no: number;
  owner_name: string;
  owner_cik: string;
  is_officer: boolean;
  is_director: boolean;
  is_ten_percent_owner: boolean;
  officer_title?: string | null;
  transaction_code: string;
  transaction_date: string; // YYYY-MM-DD
  shares: number;
  price_per_share?: number | null;
  acquired_disposed_code?: string | null;
  is_10b5_1: boolean;
  filed_at: string; // YYYY-MM-DD
}

/**
 * Upserts on (accession_number, line_no) — see the unique constraint in
 * supabase/migrations/20261001000000_insider_transactions.sql. Same
 * chunking rationale as writeDataPoints, though volume here is tiny by
 * comparison (a handful of filings/day across 7 tickers at most).
 */
export async function writeInsiderTransactions(rows: InsiderTransaction[]): Promise<void> {
  if (rows.length === 0) return;

  for (let i = 0; i < rows.length; i += UPSERT_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + UPSERT_CHUNK_SIZE);
    const { error } = await supabase
      .from("insider_transactions")
      .upsert(chunk, { onConflict: "accession_number,line_no" });

    if (error) {
      throw new Error(`Supabase upsert failed for insider_transactions (rows ${i}-${i + chunk.length}): ${error.message}`);
    }
  }
}

/**
 * The BrokerageLink watchlist ticker *list* (symbols only) lives in Supabase
 * so CI can read it without access to the gitignored local watchlist file —
 * see supabase/migrations/20260711000000_watchlist_tickers.sql. Returns []
 * (not an error) if the table is empty, so this source degrades to a no-op
 * rather than failing the run when nothing's configured yet.
 */
export async function readWatchlistTickers(): Promise<string[]> {
  const { data, error } = await supabase.from("watchlist_tickers").select("symbol");
  if (error) {
    throw new Error(`Failed to read watchlist_tickers: ${error.message}`);
  }
  return (data ?? []).map((row) => row.symbol as string);
}
