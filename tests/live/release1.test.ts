// Self-check: live API end-to-end — boot startServer, seed sessions, hit endpoints.
// Run with: bun run tests/live/release1.test.ts
import { strict as assert } from "assert";
import { openMetricsDb } from "../../src/db/schema";
import { recordTurn, upsertSession, upsertTokenSnapshot, insertContextEvent } from "../../src/db/queries";
import { startServer } from "../../src/server/api";

let passed = 0;
let failed = 0;
const test = async (name: string, fn: () => Promise<void>): Promise<void> => {
  try {
    await fn();
    console.log(`  ok  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL ${name}\n    ${err instanceof Error ? err.message : err}`);
    failed++;
  }
};

async function json(res: Response): Promise<unknown> {
  return res.json();
}

console.log("release1 live-test");

await test("turn table rows + root-cause events come back through /api/sessions/:id", async () => {
  const db = openMetricsDb(":memory:");
  try {
    // Session A: monotonic context growth → should trigger context_accumulation
    upsertSession(db, {
      conversation_id: "sess-A",
      title: "growing session",
      model: "claude-sonnet-4-5-20250929",
    });
    recordTurn(db, { conversation_id: "sess-A", generation_id: "g1", tokens: { input: 1000, output: 50 }, model: "claude-sonnet-4-5-20250929" });
    recordTurn(db, { conversation_id: "sess-A", generation_id: "g2", tokens: { input: 2000, output: 50 }, model: "claude-sonnet-4-5-20250929" });
    recordTurn(db, { conversation_id: "sess-A", generation_id: "g3", tokens: { input: 4000, output: 50 }, model: "claude-sonnet-4-5-20250929" });
    insertContextEvent(db, { conversation_id: "sess-A", context_usage_percent: 88, created_at: Date.now() });

    // Session B: unknown model → pricing_uncertainty
    upsertSession(db, {
      conversation_id: "sess-B",
      title: "unknown model session",
      model: null,
    });
    recordTurn(db, { conversation_id: "sess-B", generation_id: "g1", tokens: { input: 8000, output: 200 }, model: null });

    // Force rollup so detectors run
    const { recomputeRollup } = await import("../../src/db/queries");
    recomputeRollup(db, "sess-A");
    recomputeRollup(db, "sess-B");

    const { port, stop } = startServer(db, { port: 0 });
    try {
      const base = `http://127.0.0.1:${port}`;

      const detailA = (await json(await fetch(`${base}/api/sessions/sess-A`))) as {
        conversation_id: string;
        turns: Array<{ total_cost_usd: number; input_tokens: number }>;
        root_causes: Array<{ category: string; confidence: number }>;
        context_events: Array<{ context_usage_percent: number }>;
      };
      assert.equal(detailA.conversation_id, "sess-A");
      assert.equal(detailA.turns.length, 3, "three turns surfaced");
      assert.ok(detailA.turns[2]!.total_cost_usd > 0, "last turn has cost");
      assert.ok(detailA.turns[2]!.input_tokens === 4000);
      assert.equal(detailA.context_events.length, 1, "context event surfaced");
      const ctx = detailA.root_causes.find((e) => e.category === "context_accumulation");
      assert.ok(ctx, "context_accumulation event surfaced");
      assert.ok(ctx!.confidence >= 0.8, `confidence ${ctx!.confidence} ≥ 0.8`);

      const detailB = (await json(await fetch(`${base}/api/sessions/sess-B`))) as {
        turns: Array<{ total_cost_usd: number }>;
        root_causes: Array<{ category: string }>;
      };
      const price = detailB.root_causes.find((e) => e.category === "pricing_uncertainty");
      assert.ok(price, "pricing_uncertainty event surfaced for unknown model");
      assert.ok(detailB.turns[0]!.total_cost_usd >= 0, "B turn has cost computed via default price");

      // /api/sessions lists both
      const sessions = (await json(await fetch(`${base}/api/sessions`))) as Array<{
        conversation_id: string;
      }>;
      const ids = sessions.map((s) => s.conversation_id);
      assert.ok(ids.includes("sess-A"));
      assert.ok(ids.includes("sess-B"));

      // /api/health is up
      const health = (await json(await fetch(`${base}/api/health`))) as { ok: boolean };
      assert.equal(health.ok, true);
    } finally {
      stop();
    }
  } finally {
    db.close();
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
