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
