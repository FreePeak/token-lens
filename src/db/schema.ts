import { Database } from "bun:sqlite";
import { homedir } from "os";
import { mkdirSync } from "fs";
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
  source TEXT DEFAULT 'hook'
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
  context_tokens INTEGER,
  model TEXT,
  created_at INTEGER,
  estimated INTEGER NOT NULL DEFAULT 0,
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
  search_calls INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_rollups_started ON session_rollups(started_at);
CREATE INDEX IF NOT EXISTS idx_rollups_cost ON session_rollups(total_cost_usd);
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
}

export function openMetricsDb(path = METRICS_DB_PATH): Database {
  mkdirSync(METRICS_DIR, { recursive: true });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

export function cursorStateDbPath(): string {
  return join(
    homedir(),
    "Library/Application Support/Cursor/User/globalStorage/state.vscdb",
  );
}
