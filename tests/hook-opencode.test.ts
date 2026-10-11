// Self-check: OpenCode live hook translates payloads into sessions/turns/tool_calls
// Run with: bun run tests/hook-opencode.test.ts
import { strict as assert } from "assert";
import { openMetricsDb } from "../src/db/schema";
import { handleOpenCodeHook, isOpenCodePayload } from "../src/collector/hook-opencode";

let passed = 0, failed = 0;
const test = async (name: string, fn: () => Promise<void> | void) => {
  try { await fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}\n    ${e instanceof Error ? e.message : e}`); failed++; }
};

console.log("hook-opencode self-check");

await test("isOpenCodePayload detects hook_source", () => {
  assert.equal(isOpenCodePayload({ hook_source: "opencode" } as never), true);
  assert.equal(isOpenCodePayload({ hook_source: "cursor" } as never), false);
  assert.equal(isOpenCodePayload({} as never), false);
});

await test("sessionStart creates session with profile .opencode", () => {
  const db = openMetricsDb(":memory:");
  try {
    handleOpenCodeHook(db, { hook_source: "opencode", hook_event_name: "sessionStart", session_id: "hook-ses-1", workspace_path: "/tmp/foo", model_id: "test-model" } as never);
    const row = db.query(`SELECT profile, workspace_path, model FROM sessions WHERE conversation_id = ?`).get("hook-ses-1") as { profile: string; workspace_path: string; model: string } | null;
    assert.ok(row);
    assert.equal(row!.profile, ".opencode");
    assert.equal(row!.workspace_path, "/tmp/foo");
    assert.equal(row!.model, "test-model");
  } finally { db.close(); }
});

await test("postToolUse inserts tool_call with normalized label", () => {
  const db = openMetricsDb(":memory:");
  try {
    handleOpenCodeHook(db, { hook_source: "opencode", hook_event_name: "sessionStart", session_id: "hook-ses-2" } as never);
    handleOpenCodeHook(db, { hook_source: "opencode", hook_event_name: "postToolUse", session_id: "hook-ses-2", tool_name: "bash", tool_input: { command: "ls -la" } } as never);
    const rows = db.query(`SELECT tool_name FROM tool_calls WHERE conversation_id = ?`).all("hook-ses-2") as Array<{ tool_name: string }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.tool_name, "terminal:ls");
  } finally { db.close(); }
});

await test("afterAgentResponse creates turn + token_snapshot + rollup cost", () => {
  const db = openMetricsDb(":memory:");
  try {
    handleOpenCodeHook(db, { hook_source: "opencode", hook_event_name: "sessionStart", session_id: "hook-ses-3", model_id: "deepseek-v4-flash" } as never);
    handleOpenCodeHook(db, {
      hook_source: "opencode", hook_event_name: "afterAgentResponse", session_id: "hook-ses-3",
      generation_id: "gen-42", input_tokens: 100, output_tokens: 50, cache_read_tokens: 10, cache_write_tokens: 5, model_id: "deepseek-v4-flash"
    } as never);
    const snap = db.query(`SELECT input_tokens, output_tokens FROM token_snapshots WHERE conversation_id = ?`).get("hook-ses-3") as { input_tokens: number; output_tokens: number } | null;
    assert.ok(snap);
    assert.equal(snap!.input_tokens, 100);
    assert.equal(snap!.output_tokens, 50);
    const turn = db.query(`SELECT status FROM turns WHERE conversation_id = ? AND generation_id = ?`).get("hook-ses-3", "gen-42") as { status: string } | null;
    assert.ok(turn);
    const rollup = db.query(`SELECT total_tokens FROM session_rollups WHERE conversation_id = ?`).get("hook-ses-3") as { total_tokens: number } | null;
    assert.ok(rollup && rollup.total_tokens > 0);
  } finally { db.close(); }
});

await test("sessionEnd sets ended_at and duration_ms", async () => {
  const db = openMetricsDb(":memory:");
  try {
    handleOpenCodeHook(db, { hook_source: "opencode", hook_event_name: "sessionStart", session_id: "hook-ses-4" } as never);
    // small delay to ensure ended_at > started_at
    await new Promise(r => setTimeout(r, 2));
    handleOpenCodeHook(db, { hook_source: "opencode", hook_event_name: "sessionEnd", session_id: "hook-ses-4", duration_ms: 1234 } as never);
    const row = db.query(`SELECT ended_at, duration_ms FROM sessions WHERE conversation_id = ?`).get("hook-ses-4") as { ended_at: number | null; duration_ms: number | null } | null;
    assert.ok(row?.ended_at);
    assert.equal(row?.duration_ms, 1234);
  } finally { db.close(); }
});

await test("dispatcher routes via hook_source", async () => {
  const db = openMetricsDb(":memory:");
  try {
    const { handleHook } = await import("../src/collector/hook");
    // payload without --tool flag but with hook_source=opencode should route to opencode handler
    handleHook(db, { hook_source: "opencode", hook_event_name: "sessionStart", session_id: "hook-ses-5" } as never);
    const row = db.query(`SELECT profile FROM sessions WHERE conversation_id = ?`).get("hook-ses-5") as { profile: string } | null;
    assert.ok(row);
    assert.equal(row!.profile, ".opencode");
  } finally { db.close(); }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
