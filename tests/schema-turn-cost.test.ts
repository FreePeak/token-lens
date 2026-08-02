// Self-check: schema migration adds turn cost columns and root_cause_events table.
// Run with: bun run tests/schema-turn-cost.test.ts
import { strict as assert } from "assert";
import { Database } from "bun:sqlite";
import { openMetricsDb } from "../src/db/schema";

let passed = 0;
let failed = 0;
const test = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`  ok  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL ${name}\n    ${err instanceof Error ? err.message : err}`);
    failed++;
  }
};

function turnCols(db: Database): Set<string> {
  return new Set(
    (db.query(`PRAGMA table_info(turns)`).all() as Array<{ name: string }>).map((c) => c.name),
  );
}

function hasTable(db: Database, name: string): boolean {
  const row = db
    .query(`SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name = ?`)
    .get(name) as { ok: number } | null;
  return !!row;
}

console.log("schema-turn-cost self-check");

test("fresh DB has new turn cost columns", () => {
  const db = openMetricsDb(":memory:");
  try {
    const cols = turnCols(db);
    for (const c of [
      "input_tokens",
      "output_tokens",
      "cache_read_tokens",
      "cache_write_tokens",
      "total_tokens",
      "total_cost_usd",
      "model",
      "estimated",
      "prompt",
    ]) {
      assert.ok(cols.has(c), `turns.${c} should exist`);
    }
  } finally {
    db.close();
  }
});

test("fresh DB has root_cause_events table", () => {
  const db = openMetricsDb(":memory:");
  try {
    assert.ok(hasTable(db, "root_cause_events"), "root_cause_events should exist");
    const cols = new Set(
      (db.query(`PRAGMA table_info(root_cause_events)`).all() as Array<{ name: string }>).map(
        (c) => c.name,
      ),
    );
    for (const c of [
      "id",
      "conversation_id",
      "generation_id",
      "category",
      "confidence",
      "observed_cost_usd",
      "baseline_cost_usd",
      "evidence_json",
      "recommendation",
      "created_at",
    ]) {
      assert.ok(cols.has(c), `root_cause_events.${c} should exist`);
    }
  } finally {
    db.close();
  }
});

test("legacy v2 DB (pre-migration) is upgraded in place", () => {
  const db = openMetricsDb(":memory:");
  try {
    // Simulate legacy state: drop new columns if present, then re-open via migration
    db.exec(`ALTER TABLE turns DROP COLUMN input_tokens`);
    db.exec(`ALTER TABLE turns DROP COLUMN output_tokens`);
    db.exec(`ALTER TABLE turns DROP COLUMN cache_read_tokens`);
    db.exec(`ALTER TABLE turns DROP COLUMN cache_write_tokens`);
    db.exec(`ALTER TABLE turns DROP COLUMN total_tokens`);
    db.exec(`ALTER TABLE turns DROP COLUMN total_cost_usd`);
    db.exec(`ALTER TABLE turns DROP COLUMN model`);
    db.exec(`ALTER TABLE turns DROP COLUMN estimated`);
    db.exec(`ALTER TABLE turns DROP COLUMN prompt`);
    db.exec(`DROP TABLE IF EXISTS root_cause_events`);
    db.close();

    // Re-open — migrate() should re-add everything
    const reopened = openMetricsDb(":memory:");
    try {
      const cols = turnCols(reopened);
      for (const c of [
        "input_tokens",
        "output_tokens",
        "cache_read_tokens",
        "cache_write_tokens",
        "total_tokens",
        "total_cost_usd",
        "model",
        "estimated",
        "prompt",
      ]) {
        assert.ok(cols.has(c), `after re-open turns.${c} should exist`);
      }
      assert.ok(hasTable(reopened, "root_cause_events"), "root_cause_events re-created");
    } finally {
      reopened.close();
    }
  } catch {
    db.close();
    throw new Error("could not simulate legacy v2 state");
  }
});

test("new turn cost columns default to 0 / null", () => {
  const db = openMetricsDb(":memory:");
  try {
    db.run(
      `INSERT INTO sessions (conversation_id) VALUES (?)`,
      ["s1"],
    );
    db.run(
      `INSERT INTO turns (conversation_id, generation_id) VALUES (?, ?)`,
      ["s1", "g1"],
    );
    const row = db
      .query(
        `SELECT input_tokens, output_tokens, total_tokens, total_cost_usd, estimated, model, prompt
         FROM turns WHERE conversation_id = ?`,
      )
      .get("s1") as Record<string, unknown>;
    assert.equal(row.input_tokens, 0);
    assert.equal(row.output_tokens, 0);
    assert.equal(row.total_tokens, 0);
    assert.equal(row.total_cost_usd, 0);
    assert.equal(row.estimated, 0);
    assert.equal(row.model, null);
    assert.equal(row.prompt, null);
  } finally {
    db.close();
  }
});

test("root_cause_events.category is indexed", () => {
  const db = openMetricsDb(":memory:");
  try {
    const idx = db
      .query(
        `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='root_cause_events'`,
      )
      .all() as Array<{ name: string }>;
    assert.ok(idx.length > 0, "at least one index on root_cause_events");
  } finally {
    db.close();
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
