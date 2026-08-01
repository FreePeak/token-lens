// Self-check: tool registry has the expected tools with working backfill+hooks.
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

await run("claude-code is wired with backfill + installHooks", () => {
  const t = getTool("claude-code");
  assert.ok(t, "claude-code must be registered");
  assert.equal(t!.displayName, "Claude Code");
  assert.equal(typeof t!.backfill, "function");
  assert.equal(typeof t!.installHooks, "function");
  // backfill on an empty DB does not throw
  const db = openMetricsDb(":memory:");
  try {
    // Don't actually run; just check shape — invoking it could touch the real
    // ~/.claude directory which we don't want during tests.
    assert.equal(typeof (t!.backfill as (...args: unknown[]) => unknown), "function");
  } finally {
    db.close();
  }
});

await run("opencode is wired with backfill + installHooks", () => {
  const t = getTool("opencode");
  assert.ok(t, "opencode must be registered");
  assert.equal(t!.displayName, "OpenCode");
  assert.equal(typeof t!.backfill, "function");
  assert.equal(typeof t!.installHooks, "function");
});

await run("backfillClaudeCode with no install runs cleanly against in-memory DB", async () => {
  const { backfillClaudeCode } = await import("../src/collector/claude-code");
  const db = openMetricsDb(":memory:");
  try {
    const r = await backfillClaudeCode(db, { claudeHome: "/nonexistent-empty-dir" });
    assert.equal(r.sessions, 0);
  } finally {
    db.close();
  }
});

await run("backfillOpenCode with no install runs cleanly against in-memory DB", async () => {
  const { backfillOpenCode } = await import("../src/collector/opencode");
  const db = openMetricsDb(":memory:");
  try {
    const r = await backfillOpenCode(db, { opencodeHome: "/nonexistent-empty-dir" });
    assert.equal(r.sessions, 0);
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

