// Self-check: OpenCode SQLite collector produces sessions, tokens, turns, tool calls.
// Run with: bun run tests/collector-opencode.test.ts
import { strict as assert } from "assert";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Database } from "bun:sqlite";
import { openMetricsDb } from "../src/db/schema";
import {
  discoverOpenCodeRoots,
  normalizeOpenCodeSessionModel,
  parseOpenCodeDb,
  type OpenCodeRoot,
} from "../src/collector/opencode";

let passed = 0;
let failed = 0;
const test = async (name: string, fn: () => Promise<void> | void): Promise<void> => {
  try {
    await fn();
    console.log(`  ok  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL ${name}\n    ${err instanceof Error ? err.message : err}`);
    failed++;
  }
};

function newDb(): Database {
  return openMetricsDb(":memory:");
}

/**
 * Build a tiny SQLite db mimicking OpenCode's schema
 * (session, message, part). Returns the absolute path.
 */
function buildFixtureDb(dir: string): string {
  const dbPath = join(dir, "opencode.db");
  const source = new Database(":memory:");
  source.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      parent_id TEXT,
      slug TEXT NOT NULL,
      directory TEXT NOT NULL,
      title TEXT NOT NULL,
      version TEXT NOT NULL,
      share_url TEXT,
      summary_additions INTEGER,
      summary_deletions INTEGER,
      summary_files INTEGER,
      summary_diffs TEXT,
      revert TEXT,
      permission TEXT,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      time_compacting INTEGER,
      time_archived INTEGER,
      workspace_id TEXT,
      path TEXT,
      agent TEXT,
      model TEXT,
      cost REAL DEFAULT 0 NOT NULL,
      tokens_input INTEGER DEFAULT 0 NOT NULL,
      tokens_output INTEGER DEFAULT 0 NOT NULL,
      tokens_reasoning INTEGER DEFAULT 0 NOT NULL,
      tokens_cache_read INTEGER DEFAULT 0 NOT NULL,
      tokens_cache_write INTEGER DEFAULT 0 NOT NULL,
      metadata TEXT
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
  `);

  source.run(
    `INSERT INTO session
       (id, project_id, slug, directory, title, version,
        time_created, time_updated, model, cost,
        tokens_input, tokens_output, tokens_cache_read, tokens_cache_write)
     VALUES
       ('ses_1', 'prj_1', 's1', '/Users/x/y', 'hello', '0',
        1785000000000, 1785000060000, ?, 0.012,
        100, 50, 5000, 200)`,
    [JSON.stringify({ id: "deepseek-v4-flash", providerID: "opencode-go", variant: "max" })],
  );

  // user message + assistant message + tool part
  source.run(
    `INSERT INTO message (id, session_id, time_created, time_updated, data)
     VALUES ('m1', 'ses_1', 1785000001000, 1785000001000, ?)`,
    [JSON.stringify({ role: "user", time: { created: 1785000001000 }, content: [] })],
  );
  source.run(
    `INSERT INTO message (id, session_id, time_created, time_updated, data)
     VALUES ('m2', 'ses_1', 1785000002000, 1785000002000, ?)`,
    [
      JSON.stringify({
        role: "assistant",
        time: { created: 1785000002000, completed: 1785000003000 },
        tokens: { total: 150, input: 100, output: 50, cache: { read: 5000, write: 200 } },
        modelID: "deepseek-v4-flash",
        providerID: "opencode-go",
        finish: "tool-calls",
      }),
    ],
  );
  source.run(
    `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
     VALUES ('p1', 'm2', 'ses_1', 1785000002100, 1785000002500, ?)`,
    [
      JSON.stringify({
        type: "tool",
        tool: "bash",
        callID: "call_1",
        state: {
          status: "completed",
          input: { command: "ls -la", description: "list files" },
          output: "ok",
          metadata: { exit: 0 },
        },
      }),
    ],
  );

  // Persist the schema/data to disk so the collector can open it read-only.
  source.run(`VACUUM INTO ?`, [dbPath]);
  source.close();
  // Touch the file to ensure it persists (VACUUM INTO handles that).
  return dbPath;
}

console.log("collector-opencode self-check");

await test("normalizeOpenCodeSessionModel prefers model.id and strips variant", () => {
  const json = JSON.stringify({ id: "deepseek-v4-flash", providerID: "opencode-go", variant: "max" });
  assert.equal(normalizeOpenCodeSessionModel(json), "deepseek-v4-flash");
  const stringy = JSON.stringify({ id: "claude-sonnet-4-5-20250929" });
  assert.equal(normalizeOpenCodeSessionModel(stringy), "claude-sonnet-4-5-20250929");
  assert.equal(normalizeOpenCodeSessionModel(null), "");
  assert.equal(normalizeOpenCodeSessionModel(""), "");
  assert.equal(normalizeOpenCodeSessionModel("plain-model"), "plain-model");
});

await test("discoverOpenCodeRoots finds <homedir>/.local/share/opencode when present", () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "opencode-home-"));
  try {
    const target = join(fakeHome, ".local", "share", "opencode");
    const { mkdirSync } = require("fs") as typeof import("fs");
    mkdirSync(target, { recursive: true });
    // Build a real db so it passes the table probe
    const dbPath = buildFixtureDb(target);
    writeFileSync(join(target, "marker.txt"), "dummy"); // ensure dir isn't a stale empty dir
    void dbPath;

    // Pass the resolved opencode home (the directory containing opencode.db).
    const roots = discoverOpenCodeRoots(target);
    assert.equal(roots.length, 1);
    assert.equal(roots[0]!.label, ".opencode");
    assert.ok(roots[0]!.dbPath.endsWith("opencode.db"));
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

await test("parseOpenCodeDb writes a session row with costs and tool calls", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-"));
  try {
    const dbPath = buildFixtureDb(dir);
    const root: OpenCodeRoot = {
      home: dir,
      dbPath,
      label: ".opencode",
    };
    const db = newDb();
    try {
      const r = await parseOpenCodeDb(db, root);
      assert.equal(r.ok, true);

      const sess = db.query(`SELECT conversation_id, model, profile, workspace_path FROM sessions WHERE conversation_id = ?`).get("ses_1") as Record<string, unknown> | null;
      assert.ok(sess, "session row exists");
      assert.equal(sess!.model, "deepseek-v4-flash");
      assert.equal(sess!.profile, ".opencode");
      assert.equal(sess!.workspace_path, "/Users/x/y");

      const rollup = db.query(`SELECT total_cost_usd FROM session_rollups WHERE conversation_id = ?`).get("ses_1") as { total_cost_usd: number } | null;
      assert.ok(rollup, "rollup row exists");
      assert.ok(rollup!.total_cost_usd >= 0, "cost should be computed");

      const tokens = db.query(`SELECT SUM(input_tokens) AS i, SUM(output_tokens) AS o, SUM(cache_read_tokens) AS cr FROM token_snapshots WHERE conversation_id = ?`).get("ses_1") as { i: number | null; o: number | null; cr: number | null };
      // session.tokens_* populates a single token_snapshot row per session (rollup-level)
      assert.ok((tokens.i ?? 0) > 0, "some input tokens captured");
      assert.ok((tokens.o ?? 0) > 0, "some output tokens captured");
      assert.ok((tokens.cr ?? 0) > 0, "some cache-read tokens captured");

      const tools = db.query(`SELECT tool_name FROM tool_calls WHERE conversation_id = ? ORDER BY id`).all("ses_1") as Array<{ tool_name: string }>;
      assert.equal(tools.length, 1, "exactly one tool call recorded");
      assert.equal(tools[0]!.tool_name, "terminal:ls");
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test("backfillOpenCode with no install is a no-op", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-empty-"));
  try {
    const db = newDb();
    try {
      const { backfillOpenCode } = await import("../src/collector/opencode");
      const r = await backfillOpenCode(db, { opencodeHome: dir });
      assert.equal(r.sessions, 0);
      assert.equal(r.toolCalls, 0);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test("multiple sessions roll up correctly with their own workspaces", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-multi-"));
  try {
    const dbPath = join(dir, "opencode.db");
    const source = new Database(":memory:");
    source.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        slug TEXT NOT NULL,
        directory TEXT NOT NULL,
        title TEXT NOT NULL,
        version TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        model TEXT, cost REAL DEFAULT 0,
        tokens_input INTEGER DEFAULT 0, tokens_output INTEGER DEFAULT 0,
        tokens_reasoning INTEGER DEFAULT 0,
        tokens_cache_read INTEGER DEFAULT 0, tokens_cache_write INTEGER DEFAULT 0
      );
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
    `);
    source.run(
      `INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated, model, cost, tokens_input, tokens_output) VALUES
         ('s_a', 'p', 'sa', '/work/a', 'A session', '0', 1700000000000, 1700000060000, 'claude-sonnet-4-5-20250929', 0.001, 10, 5),
         ('s_b', 'p', 'sb', '/work/b', 'B session', '0', 1700001000000, 1700001060000, 'claude-sonnet-4-5-20250929', 0.002, 20, 10)`,
    );
    source.run(`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES
       ('mu_a', 's_a', 1700000001000, 1700000001000, ?),
       ('ma_a', 's_a', 1700000002000, 1700000002000, ?),
       ('mu_b', 's_b', 1700001001000, 1700001001000, ?)`,
      [
        JSON.stringify({ role: "user", time: { created: 1700000001000 } }),
        JSON.stringify({ role: "assistant", time: { created: 1700000002000 }, finish: "stop" }),
        JSON.stringify({ role: "user", time: { created: 1700001001000 } }),
      ],
    );
    source.run(`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES
       ('pa_a', 'ma_a', 's_a', 1700000002100, 1700000002500, ?)`,
      [
        JSON.stringify({ type: "tool", tool: "Read", callID: "c1", state: { status: "completed", input: { filePath: "/foo" }, output: "" } }),
      ],
    );
    source.run(`VACUUM INTO ?`, [dbPath]);
    source.close();

    const db = newDb();
    try {
      const root: OpenCodeRoot = { home: dir, dbPath, label: ".opencode" };
      const r = await parseOpenCodeDb(db, root);
      assert.equal(r.ok, true, "parseOpenCodeDb ok — error: " + (r.error ?? "none"));

      const rows = db.query(`SELECT conversation_id, workspace_path, total_cost_usd FROM session_rollups ORDER BY conversation_id`).all() as Array<{ conversation_id: string; workspace_path: string; total_cost_usd: number }>;
      assert.equal(rows.length, 2);
      assert.equal(rows[0]!.conversation_id, "s_a");
      assert.equal(rows[0]!.workspace_path, "/work/a");
      assert.equal(rows[1]!.workspace_path, "/work/b");

      const reads = db.query(`SELECT conversation_id, COUNT(*) AS n FROM tool_calls WHERE tool_name LIKE 'read:%' OR tool_name = 'Read' GROUP BY conversation_id`).all() as Array<{ conversation_id: string; n: number }>;
      assert.equal(reads.length, 1, "only s_a used the Read tool");
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
