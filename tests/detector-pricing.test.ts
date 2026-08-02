// Self-check: pricing_uncertainty detector fires when model is unknown / null.
// Run with: bun run tests/detector-pricing.test.ts
import { strict as assert } from "assert";
import { openMetricsDb } from "../src/db/schema";
import { recordTurn, upsertSession } from "../src/db/queries";
import { detectPricingUncertainty } from "../src/detector/pricing-uncertainty";
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

console.log("detector-pricing self-check");

test("known model with no default_price → no event", () => {
  const db = newDb();
  try {
    upsertSession(db, { conversation_id: "c1" });
    recordTurn(db, {
      conversation_id: "c1",
      generation_id: "g1",
      tokens: { input: 1000, output: 100 },
      model: "claude-sonnet-4-5-20250929",
    });
    const ev = detectPricingUncertainty(db, "c1");
    assert.equal(ev, null);
    assert.equal(listRootCauseEvents(db, { conversationId: "c1" }).length, 0);
  } finally {
    db.close();
  }
});

test("unknown model → fires pricing_uncertainty", () => {
  const db = newDb();
  try {
    upsertSession(db, { conversation_id: "c1" });
    recordTurn(db, {
      conversation_id: "c1",
      generation_id: "g1",
      tokens: { input: 5000, output: 200 },
      model: "totally-unknown-model-xyz",
    });
    const ev = detectPricingUncertainty(db, "c1");
    assert.ok(ev);
    assert.equal(ev!.category, "pricing_uncertainty");
    assert.ok(ev!.confidence >= 0.7);
    const evidence = JSON.parse(ev!.evidence_json);
    assert.equal(evidence.unknown_model, "totally-unknown-model-xyz");
  } finally {
    db.close();
  }
});

test("null model → fires pricing_uncertainty", () => {
  const db = newDb();
  try {
    upsertSession(db, { conversation_id: "c1" });
    recordTurn(db, {
      conversation_id: "c1",
      generation_id: "g1",
      tokens: { input: 5000, output: 200 },
      model: null,
    });
    const ev = detectPricingUncertainty(db, "c1");
    assert.ok(ev);
    assert.equal(ev!.category, "pricing_uncertainty");
    assert.equal(JSON.parse(ev!.evidence_json).unknown_model, null);
  } finally {
    db.close();
  }
});

test("input_tokens ≥ 50k bumps confidence to 0.95", () => {
  const db = newDb();
  try {
    upsertSession(db, { conversation_id: "c1" });
    recordTurn(db, {
      conversation_id: "c1",
      generation_id: "g1",
      tokens: { input: 80_000, output: 1000 },
      model: "totally-unknown-model-xyz",
    });
    const ev = detectPricingUncertainty(db, "c1");
    assert.ok(ev);
    assert.equal(ev!.confidence, 0.95);
  } finally {
    db.close();
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
