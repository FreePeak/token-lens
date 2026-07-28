import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export const METRICS_DIR = join(homedir(), ".cursor-metrics");
export const METRICS_DB_PATH = join(METRICS_DIR, "metrics.db");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  conversation_id TEXT PRIMARY KEY,
  title TEXT,
  workspace TEXT,
  model TEXT,
  mode TEXT,
  started_at INTEGER,
  ended_at INTEGER,
  duration_ms INTEGER,
  source TEXT DEFAULT 'hook',
  first_prompt TEXT,
  profile TEXT
);

CREATE TABLE IF NOT EXISTS turns (
  conversation_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  status TEXT,
  started_at INTEGER,
  ended_at INTEGER,
  PRIMARY KEY (conversation_id, generation_id)
);

CREATE TABLE IF NOT EXISTS tool_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  generation_id TEXT,
  tool_name TEXT NOT NULL,
  duration_ms INTEGER,
  success INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tool_calls_conv ON tool_calls(conversation_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_name ON tool_calls(tool_name);

CREATE TABLE IF NOT EXISTS token_snapshots (
  conversation_id TEXT NOT NULL,
  bubble_id TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  context_tokens INTEGER,
  model TEXT,
  created_at INTEGER,
  estimated INTEGER NOT NULL DEFAULT 0,
  prompt TEXT,
  PRIMARY KEY (conversation_id, bubble_id)
);

CREATE INDEX IF NOT EXISTS idx_token_snapshots_conv ON token_snapshots(conversation_id);

CREATE TABLE IF NOT EXISTS context_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  context_tokens INTEGER,
  context_usage_percent REAL,
  context_window_size INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS session_rollups (
  conversation_id TEXT PRIMARY KEY,
  title TEXT,
  workspace TEXT,
  model TEXT,
  mode TEXT,
  started_at INTEGER,
  ended_at INTEGER,
  duration_ms INTEGER,
  num_turns INTEGER NOT NULL DEFAULT 0,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  file_reads INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  total_cost_usd REAL NOT NULL DEFAULT 0,
  tokens_estimated INTEGER NOT NULL DEFAULT 0,
  used_leankg INTEGER NOT NULL DEFAULT 0,
  leankg_calls INTEGER NOT NULL DEFAULT 0,
  search_calls INTEGER NOT NULL DEFAULT 0,
  first_prompt TEXT,
  profile TEXT
);

CREATE INDEX IF NOT EXISTS idx_rollups_started ON session_rollups(started_at);
CREATE INDEX IF NOT EXISTS idx_rollups_cost ON session_rollups(total_cost_usd);

CREATE TABLE IF NOT EXISTS overview_cache (
  key TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  computed_at INTEGER NOT NULL,
  source_session_count INTEGER NOT NULL
);
`;

function migrate(db: Database): void {
  const cols = new Set(
    (db.query(`PRAGMA table_info(session_rollups)`).all() as Array<{ name: string }>).map(
      (c) => c.name,
    ),
  );
  const add = (name: string, ddl: string) => {
    if (!cols.has(name)) db.exec(`ALTER TABLE session_rollups ADD COLUMN ${ddl}`);
  };
  add("tokens_estimated", "tokens_estimated INTEGER NOT NULL DEFAULT 0");
  add("used_leankg", "used_leankg INTEGER NOT NULL DEFAULT 0");
  add("leankg_calls", "leankg_calls INTEGER NOT NULL DEFAULT 0");
  add("search_calls", "search_calls INTEGER NOT NULL DEFAULT 0");

  const tcols = new Set(
    (db.query(`PRAGMA table_info(token_snapshots)`).all() as Array<{ name: string }>).map(
      (c) => c.name,
    ),
  );
  if (!tcols.has("estimated")) {
    db.exec(`ALTER TABLE token_snapshots ADD COLUMN estimated INTEGER NOT NULL DEFAULT 0`);
  }
  if (!tcols.has("cache_read_tokens")) {
    db.exec(`ALTER TABLE token_snapshots ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0`);
  }
  if (!tcols.has("cache_write_tokens")) {
    db.exec(`ALTER TABLE token_snapshots ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0`);
  }
  if (!tcols.has("prompt")) {
    db.exec(`ALTER TABLE token_snapshots ADD COLUMN prompt TEXT`);
  }

  const scols = new Set(
    (db.query(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (!scols.has("first_prompt")) {
    db.exec(`ALTER TABLE sessions ADD COLUMN first_prompt TEXT`);
  }
  if (!scols.has("profile")) {
    db.exec(`ALTER TABLE sessions ADD COLUMN profile TEXT`);
  }
  if (!scols.has("last_backfilled_at")) {
    db.exec(`ALTER TABLE sessions ADD COLUMN last_backfilled_at INTEGER`);
  }
  add("first_prompt", "first_prompt TEXT");
  add("profile", "profile TEXT");
  // session_rollups.cache_reads / cache_writes = SUM of prompt-cache tokens (not event counts)
  add("cache_reads", "cache_reads INTEGER NOT NULL DEFAULT 0");
  add("cache_writes", "cache_writes INTEGER NOT NULL DEFAULT 0");
}

export function openMetricsDb(path = METRICS_DB_PATH): Database {
  mkdirSync(METRICS_DIR, { recursive: true });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 30000;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** Candidate globalStorage state.vscdb roots — ~/.cur + ~/.cursor first (user profiles). */
export function cursorStateDbCandidates(): string[] {
  const home = homedir();
  return [
    join(home, ".cur/User/globalStorage/state.vscdb"),
    join(home, ".cursor/User/globalStorage/state.vscdb"),
    join(home, "Library/Application Support/Cur/User/globalStorage/state.vscdb"),
    join(home, "Library/Application Support/Cursor/User/globalStorage/state.vscdb"),
    join(home, ".config/Cursor/User/globalStorage/state.vscdb"),
  ];
}

/** Short filter label: `.cur` | `.cursor`. */
export function profileFromStatePath(statePath: string): string {
  const n = statePath.replace(/\\/g, "/");
  // ~/.cursor and Application Support/Cursor → .cursor
  if (n.includes("/.cursor/") || /\/\.cursor$/i.test(n)) return ".cursor";
  if (/\/Application Support\/Cursor\//i.test(n)) return ".cursor";
  if (n.includes("/.config/Cursor/")) return ".cursor";
  // ~/.cur and Application Support/Cur → .cur
  if (n.includes("/.cur/") || /\/\.cur$/i.test(n)) return ".cur";
  if (/\/Application Support\/Cur\//i.test(n)) return ".cur";
  const m = n.match(/\/([^/]+)\/User\/globalStorage\//);
  return m?.[1] ?? "unknown";
}

/** Existing state DBs that look like they hold composer/bubble data. */
export function discoverCursorStateDbs(): string[] {
  const out: string[] = [];
  for (const path of cursorStateDbCandidates()) {
    if (!existsSync(path)) continue;
    try {
      const size = statSync(path).size;
      if (size < 1024) continue;
      const db = new Database(`file:${path}?mode=ro`, { readonly: true, create: false });
      try {
        const kv = db
          .query(`SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='cursorDiskKV'`)
          .get() as { ok: number } | null;
        if (!kv) continue;
        const hasHeaders = db
          .query(
            `SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='composerHeaders'`,
          )
          .get() as { ok: number } | null;
        // Prefer header table; skip expensive bubble probes on huge DBs without headers
        if (hasHeaders) {
          const n = db.query(`SELECT 1 AS ok FROM composerHeaders LIMIT 1`).get();
          if (n) out.push(path);
          continue;
        }
        if (size > 50 * 1024 * 1024) continue; // ponytail: no headers + huge = not our profile
        const bubble = db
          .query(`SELECT 1 AS ok FROM cursorDiskKV WHERE key GLOB 'bubbleId:*' LIMIT 1`)
          .get();
        if (bubble) out.push(path);
      } finally {
        db.close();
      }
    } catch {
      /* unreadable */
    }
  }
  return out;
}
