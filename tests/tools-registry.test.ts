// Self-check: tool registry has the expected tools, Cursor is supported, stubs throw clear errors.
// Run with: bun run tests/tools-registry.test.ts
import { strict as assert } from "assert";
import { listTools, getTool } from "../src/tools/registry";
import { openMetricsDb } from "../src/db/schema";

let passed = 0;
let failed = 0;
async function run(name: string, fn: () => unknown | Promise<unknown>): Promise<void> {
  try {
    await fn();
    console.log(`  ok  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL ${name}\n    ${err instanceof Error ? err.message : err}`);
    failed++;
  }
}

console.log("tools-registry self-check");

await run("cursor is the first supported tool", () => {
  const cursor = getTool("cursor");
  assert.ok(cursor, "cursor must be registered");
  assert.equal(cursor!.id, "cursor");
  assert.equal(cursor!.displayName, "Cursor");
  assert.equal(typeof cursor!.backfill, "function");
  assert.equal(typeof cursor!.installHooks, "function");
  assert.equal(cursor!.supportsUsageSync, true);
});

await run("claude-code is a stub that throws clearly", async () => {
  const t = getTool("claude-code");
  assert.ok(t, "claude-code must be registered");
  assert.equal(t!.displayName, "Claude Code");
  const db = openMetricsDb(":memory:");
  try {
    let caught: Error | null = null;
    try {
      await t!.backfill(db, { resume: true, rollup: true });
    } catch (e) {
      caught = e as Error;
    }
    assert.ok(caught, "must throw");
    assert.match(caught!.message, /not implemented/);
  } finally {
    db.close();
  }
});

await run("opencode is a stub that throws clearly", async () => {
  const t = getTool("opencode");
  assert.ok(t, "opencode must be registered");
  assert.equal(t!.displayName, "OpenCode");
  const db = openMetricsDb(":memory:");
  try {
    let caught: Error | null = null;
    try {
      await t!.backfill(db, { resume: true, rollup: true });
    } catch (e) {
      caught = e as Error;
    }
    assert.ok(caught, "must throw");
    assert.match(caught!.message, /not implemented/);
  } finally {
    db.close();
  }
});

await run("listTools returns all registered tools", () => {
  const ids = listTools().map((t) => t.id);
  assert.deepEqual(ids, ["cursor", "claude-code", "opencode"]);
});

await run("unknown tool id returns undefined", () => {
  assert.equal(getTool("vim"), undefined);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
