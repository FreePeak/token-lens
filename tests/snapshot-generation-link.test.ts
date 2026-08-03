// Self-check: token_snapshots.generation_id links snapshots to turns;
// recomputeTurn can fill a turn from its snapshots without prefix matching.
// Run with: bun run tests/snapshot-generation-link.test.ts
import { strict as assert } from "assert";
import { openMetricsDb } from "../src/db/schema";
import {
  recomputeTurn,
  upsertSession,
  upsertTokenSnapshot,
  upsertTurn,
} from "../src/db/queries";

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

function newDb() {
  return openMetricsDb(":memory:");
}

console.log("snapshot-generation-link self-check");

test("token_snapshots.generation_id column exists", () => {
  const db = newDb();
  try {
    const cols = new Set(
      (db.query(`PRAGMA table_info(token_snapshots)`).all() as Array<{ name: string }>).map(
        (c) => c.name,
      ),
    );
    assert.ok(cols.has("generation_id"), "token_snapshots.generation_id should exist");
  } finally {
    db.close();
  }
});

test("upsertTokenSnapshot writes generation_id", () => {
  const db = newDb();
  try {
    upsertSession(db, { conversation_id: "c1" });
    upsertTokenSnapshot(db, {
      conversation_id: "c1",
      bubble_id: "b1",
      input_tokens: 100,
      output_tokens: 50,
      generation_id: "g1",
    });
    const row = db
      .query(`SELECT generation_id FROM token_snapshots WHERE bubble_id = 'b1'`)
      .get() as { generation_id: string | null };
    assert.equal(row.generation_id, "g1");
  } finally {
    db.close();
  }
});

test("recomputeTurn reads by generation_id column, not bubble_id prefix", () => {
  const db = newDb();
  try {
    upsertSession(db, { conversation_id: "c1" });
    upsertTurn(db, { conversation_id: "c1", generation_id: "gen-abc-123" });
    upsertTokenSnapshot(db, {
      conversation_id: "c1",
      bubble_id: "totally-unrelated-bubble-id",
      input_tokens: 5000,
      output_tokens: 1000,
      cache_read_tokens: 250,
      model: "claude-sonnet-4-5-20250929",
      generation_id: "gen-abc-123",
      created_at: 1_700_000_000_000,
    });
    recomputeTurn(db, "c1", "gen-abc-123");
    const t = db
      .query(`SELECT * FROM turns WHERE conversation_id = 'c1'`)
      .get() as Record<string, unknown>;
    assert.equal(t.input_tokens, 5000);
    assert.equal(t.output_tokens, 1000);
    assert.equal(t.cache_read_tokens, 250);
    assert.equal(t.total_tokens, 6250);
    assert.ok((t.total_cost_usd as number) > 0);
  } finally {
    db.close();
  }
});

test("legacy snapshots without generation_id are not claimed by any turn", () => {
  const db = newDb();
  try {
    upsertSession(db, { conversation_id: "c1" });
    upsertTurn(db, { conversation_id: "c1", generation_id: "g1" });
    upsertTokenSnapshot(db, {
      conversation_id: "c1",
      bubble_id: "legacy:b1",
      input_tokens: 9999,
      output_tokens: 0,
    });
    recomputeTurn(db, "c1", "g1");
    const t = db
      .query(`SELECT input_tokens, output_tokens FROM turns WHERE conversation_id = 'c1'`)
      .get() as { input_tokens: number; output_tokens: number };
    assert.equal(t.input_tokens, 0, "no snapshot claims → turn stays empty");
    assert.equal(t.output_tokens, 0);
  } finally {
    db.close();
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
