// Mtime-gated auto-sync for prices.json. OpenRouter-derived prices overwrite
// the hand-curated table on a daily cadence (default 24h). Failures are logged
// and re-tried next call — backfill never fails on a price sync hiccup.

import { existsSync, statSync, utimesSync } from "fs";
import { join } from "path";
import { spawnSync } from "bun";
import { METRICS_DIR } from "../db/schema";

const SENTINEL = join(METRICS_DIR, "prices.last-sync");
const ONE_DAY_MS = 86_400_000;

export type SyncResult =
  | { ran: false; reason: "fresh"; ageMs: number }
  | { ran: true; ageMs: number; exitCode: number; durationMs: number };

export interface SyncOptions {
  /** Recompute only when sentinel is older than this. Default 24h. */
  maxAgeMs?: number;
  /** Override the script path (defaults to <repo>/scripts/fetch-prices.ts). */
  scriptPath?: string;
  /** Override bun executable (defaults to current process). */
  bunPath?: string;
}

export function syncPricesIfStale(opts: SyncOptions = {}): SyncResult {
  const maxAgeMs = opts.maxAgeMs ?? ONE_DAY_MS;
  const now = Date.now();
  const ageMs = existsSync(SENTINEL) ? now - statSync(SENTINEL).mtimeMs : Infinity;
  if (ageMs < maxAgeMs) return { ran: false, reason: "fresh", ageMs: Number.isFinite(ageMs) ? ageMs : -1 };

  const scriptPath = opts.scriptPath ?? join(import.meta.dir, "..", "..", "scripts", "fetch-prices.ts");
  const bunPath = opts.bunPath ?? process.execPath;
  const start = Date.now();
  const r = spawnSync({
    cmd: [bunPath, "run", scriptPath, "--apply"],
    cwd: import.meta.dir.replace(/\/src\/shared$/, ""),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const durationMs = Date.now() - start;
  if (r.exitCode === 0) {
    touchSentinel(now);
    return { ran: true, ageMs, exitCode: 0, durationMs };
  }
  const stderr = r.stderr ? new TextDecoder().decode(r.stderr).slice(-400) : "";
  console.warn(`prices auto-sync failed (exit ${r.exitCode}, ${durationMs}ms): ${stderr}`);
  return { ran: true, ageMs, exitCode: r.exitCode ?? -1, durationMs };
}

function touchSentinel(t: number): void {
  const ts = t / 1000;
  if (!existsSync(SENTINEL)) {
    Bun.write(SENTINEL, "");
  }
  utimesSync(SENTINEL, ts, ts);
}

// ponytail: sentinel is an empty file; mtime is the timestamp. Avoids extra
// metadata format and ts collisions. Add when: comparing across machines,
// then switch to JSON `{syncedAt}`.
// ponytail: spawnSync adds ~50-100ms for `bun` startup. Fine for daily cadence;
// switch to direct import + `await fetchRows()` if it ever shows in profiles.
