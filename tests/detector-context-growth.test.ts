// Self-check: context-growth detector fires on monotonic growth, skips flat sessions.
// Run with: bun run tests/detector-context-growth.test.ts
import { strict as assert } from "assert";
import { openMetricsDb } from "../src/db/schema";
import {
  recordTurn,
  upsertSession,
  upsertTurn,
} from "../src/db/queries";
import { detectContextGrowth } from "../src/detector/context-growth";
import { listRootCauseEvents } from "../src/db/root-causes";

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
  upsertSession(db, { conversation_id: id, model: "claude-sonnet-4-5-20250929" });
}

function addTurn(
  db: ReturnType<typeof openMetricsDb>,
  conv: string,
  gen: string,
  input: number,
  contextPercent: number | null = null,
) {
  upsertTurn(db, { conversation_id: conv, generation_id: gen });
  recordTurn(db, {
    conversation_id: conv,
    generation_id: gen,
    tokens: { input, output: 50 },
    model: "claude-sonnet-4-5-20250929",
  });
  if (contextPercent != null) {
    db.run(
      `INSERT INTO context_events (conversation_id, context_usage_percent, created_at)
       VALUES (?, ?, ?)`,
      [conv, contextPercent, Date.now()],
    );
  }
}

console.log("detector-context-growth self-check");

test("empty token_snapshots → no event", () => {
  const db = newDb();
  try {
    seedSession(db, "c1");
    upsertTurn(db, { conversation_id: "c1", generation_id: "g1" });
    const ev = detectContextGrowth(db, "c1");
    assert.equal(ev, null);
    assert.equal(listRootCauseEvents(db, { conversationId: "c1" }).length, 0);
  } finally {
    db.close();
  }
});

test("single-turn session never fires", () => {
  const db = newDb();
  try {
    seedSession(db, "c1");
    addTurn(db, "c1", "g1", 5000);
    const ev = detectContextGrowth(db, "c1");
    assert.equal(ev, null);
  } finally {
    db.close();
  }
});

test("all turns ≤ 2× baseline → no event", () => {
  const db = newDb();
  try {
    seedSession(db, "c1");
    addTurn(db, "c1", "g1", 1000);
    addTurn(db, "c1", "g2", 1500);
    addTurn(db, "c1", "g3", 1900);
    const ev = detectContextGrowth(db, "c1");
    assert.equal(ev, null);
  } finally {
    db.close();
  }
});

test("final turn 4× baseline → fires context_accumulation with confidence ≥ 0.8", () => {
  const db = newDb();
  try {
    seedSession(db, "c1");
    addTurn(db, "c1", "g1", 1000);
    addTurn(db, "c1", "g2", 2000);
    addTurn(db, "c1", "g3", 4000); // 4× baseline
    const ev = detectContextGrowth(db, "c1");
    assert.ok(ev, "expected event");
    assert.equal(ev!.category, "context_accumulation");
    assert.ok(ev!.confidence >= 0.8, `confidence ${ev!.confidence} >= 0.8`);
    const evidence = JSON.parse(ev!.evidence_json);
    assert.ok(evidence.input_growth_ratio >= 3.5, "growth_ratio near 4");
    assert.equal(ev!.conversation_id, "c1");
    assert.ok(ev!.recommendation.length > 0);
  } finally {
    db.close();
  }
});

test("context_usage_percent ≥ 80 bumps confidence by +0.1", () => {
  const db = newDb();
  try {
    seedSession(db, "c1");
    addTurn(db, "c1", "g1", 1000, 50);
    addTurn(db, "c1", "g2", 2000, 70);
    addTurn(db, "c1", "g3", 4000, 88); // high pressure
    const ev = detectContextGrowth(db, "c1");
    assert.ok(ev);
    const evidence = JSON.parse(ev!.evidence_json);
    assert.equal(evidence.max_context_percent, 88);
    // base growth 4× → (4-1)/3 = 1.0 capped at 1, +0.1 stays 1.0
    assert.equal(ev!.confidence, 1.0);
  } finally {
    db.close();
  }
});

test("low growth + high context pressure still fires when ≥ 3×", () => {
  const db = newDb();
  try {
    seedSession(db, "c1");
    addTurn(db, "c1", "g1", 500, 90);
    addTurn(db, "c1", "g2", 1500, 95);
    const ev = detectContextGrowth(db, "c1");
    assert.ok(ev);
    assert.equal(ev!.category, "context_accumulation");
  } finally {
    db.close();
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
