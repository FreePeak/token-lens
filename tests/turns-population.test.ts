// Self-check: recordTurn helper + recomputeTurn fill in cost columns from a token snapshot.
// Run with: bun run tests/turns-population.test.ts
import { strict as assert } from "assert";
import { openMetricsDb } from "../src/db/schema";
import {
  recomputeTurn,
  recordTurn,
  upsertSession,
  upsertTurn,
  upsertTokenSnapshot,
} from "../src/db/queries";
import { estimateCostUsd } from "../src/shared/prices";

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

function seedSession(db: ReturnType<typeof openMetricsDb>, id: string) {
  upsertSession(db, { conversation_id: id, title: `s-${id}` });
}

function getTurn(
  db: ReturnType<typeof openMetricsDb>,
  conv: string,
  gen: string,
): Record<string, unknown> {
  return db
    .query(`SELECT * FROM turns WHERE conversation_id = ? AND generation_id = ?`)
    .get(conv, gen) as Record<string, unknown>;
}

console.log("turns-population self-check");

test("recordTurn fills cost columns from a token snapshot", () => {
  const db = newDb();
  try {
    seedSession(db, "c1");
    const model = "claude-sonnet-4-5-20250929";
    recordTurn(db, {
      conversation_id: "c1",
      generation_id: "g1",
      tokens: { input: 1000, output: 200, cache_read: 50, cache_write: 0 },
      model,
      estimated: false,
      prompt: "hello",
      at: 1_700_000_000_000,
    });
    const t = getTurn(db, "c1", "g1");
    assert.equal(t.input_tokens, 1000);
    assert.equal(t.output_tokens, 200);
    assert.equal(t.cache_read_tokens, 50);
    assert.equal(t.cache_write_tokens, 0);
    assert.equal(t.total_tokens, 1250);
    const expected = estimateCostUsd(model, 1000, 200, 50, 0);
    assert.ok(Math.abs((t.total_cost_usd as number) - expected) < 1e-9);
    assert.equal(t.model, model);
    assert.equal(t.estimated, 0);
    assert.equal(t.prompt, "hello");
  } finally {
    db.close();
  }
});

test("recordTurn merges across multiple snapshots for the same generation", () => {
  const db = newDb();
  try {
    seedSession(db, "c1");
    const model = "claude-sonnet-4-5-20250929";
    recordTurn(db, {
      conversation_id: "c1",
      generation_id: "g1",
      tokens: { input: 1000, output: 100 },
      model,
    });
    recordTurn(db, {
      conversation_id: "c1",
      generation_id: "g1",
      tokens: { input: 2000, output: 300, cache_read: 100 },
      model,
    });
    const t = getTurn(db, "c1", "g1");
    assert.equal(t.input_tokens, 2000, "later (larger) wins");
    assert.equal(t.output_tokens, 300);
    assert.equal(t.cache_read_tokens, 100);
  } finally {
    db.close();
  }
});

test("recordTurn with estimated=true marks the turn", () => {
  const db = newDb();
  try {
    seedSession(db, "c1");
    recordTurn(db, {
      conversation_id: "c1",
      generation_id: "g1",
      tokens: { input: 500, output: 0 },
      model: "gpt-4",
      estimated: true,
    });
    const t = getTurn(db, "c1", "g1");
    assert.equal(t.estimated, 1);
  } finally {
    db.close();
  }
});

test("recomputeTurn fills cost columns from token_snapshots with matching generation_id", () => {
  const db = newDb();
  try {
    seedSession(db, "c1");
    const model = "claude-sonnet-4-5-20250929";
    upsertTurn(db, { conversation_id: "c1", generation_id: "g1" });
    upsertTokenSnapshot(db, {
      conversation_id: "c1",
      bubble_id: "g1:b1",
      input_tokens: 4000,
      output_tokens: 800,
      cache_read_tokens: 200,
      cache_write_tokens: 0,
      model,
      created_at: 1_700_000_000_000,
    });
    recomputeTurn(db, "c1", "g1");
    const t = getTurn(db, "c1", "g1");
    assert.equal(t.input_tokens, 4000);
    assert.equal(t.output_tokens, 800);
    assert.equal(t.cache_read_tokens, 200);
    assert.equal(t.total_tokens, 5000);
    const expected = estimateCostUsd(model, 4000, 800, 200, 0);
    assert.ok(Math.abs((t.total_cost_usd as number) - expected) < 1e-9);
  } finally {
    db.close();
  }
});

test("recomputeTurn is a no-op when no token_snapshots match the generation", () => {
  const db = newDb();
  try {
    seedSession(db, "c1");
    upsertTurn(db, { conversation_id: "c1", generation_id: "g1" });
    recomputeTurn(db, "c1", "g1");
    const t = getTurn(db, "c1", "g1");
    assert.equal(t.input_tokens, 0);
    assert.equal(t.output_tokens, 0);
    assert.equal(t.total_tokens, 0);
    assert.equal(t.total_cost_usd, 0);
  } finally {
    db.close();
  }
});

test("recomputeTurn leaves estimated flag 0 unless any snapshot is estimated", () => {
  const db = newDb();
  try {
    seedSession(db, "c1");
    upsertTurn(db, { conversation_id: "c1", generation_id: "g1" });
    upsertTokenSnapshot(db, {
      conversation_id: "c1",
      bubble_id: "g1:b1",
      input_tokens: 1000,
      output_tokens: 100,
      model: "gpt-4",
      created_at: 1,
      estimated: false,
    });
    upsertTokenSnapshot(db, {
      conversation_id: "c1",
      bubble_id: "g1:b2",
      input_tokens: 2000,
      output_tokens: 200,
      model: "gpt-4",
      created_at: 2,
      estimated: true,
    });
    recomputeTurn(db, "c1", "g1");
    const t = getTurn(db, "c1", "g1");
    assert.equal(t.estimated, 1, "any snapshot estimated → turn estimated");
    // recomputeTurn sums all matching snapshots; recordTurn maxes across calls.
    assert.equal(t.input_tokens, 3000);
    assert.equal(t.output_tokens, 300);
  } finally {
    db.close();
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
