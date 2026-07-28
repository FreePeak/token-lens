import type { Database } from "bun:sqlite";
import { getOverview } from "./queries";
import type { OverviewStats } from "../shared/types";

const CACHE_KEY = "default";

type CacheRow = {
  payload: string;
  source_session_count: number;
};

export function getOverviewCached(
  db: Database,
  sinceMs?: number,
  profile?: string,
): OverviewStats {
  // ponytail: only cache the unfiltered overview; bypass for any filter to avoid key explosion
  if (sinceMs != null || profile) return getOverview(db, sinceMs, profile);

  const row = db
    .query(`SELECT payload, source_session_count FROM overview_cache WHERE key = ?`)
    .get(CACHE_KEY) as CacheRow | null;

  const current = (
    db.query(`SELECT COUNT(*) AS n FROM session_rollups`).get() as { n: number }
  ).n;

  if (row && row.source_session_count >= current) {
    try {
      return JSON.parse(row.payload) as OverviewStats;
    } catch {
      // fall through to recompute on corrupted payload
    }
  }

  const stats = getOverview(db);
  db.run(
    `INSERT INTO overview_cache (key, payload, computed_at, source_session_count)
     VALUES ($k, $p, $at, $n)
     ON CONFLICT(key) DO UPDATE SET
       payload = excluded.payload,
       computed_at = excluded.computed_at,
       source_session_count = excluded.source_session_count`,
    { $k: CACHE_KEY, $p: JSON.stringify(stats), $at: Date.now(), $n: current },
  );
  return stats;
}

export function invalidateOverviewCache(db: Database): void {
  db.run(`DELETE FROM overview_cache WHERE key = ?`, [CACHE_KEY]);
}
