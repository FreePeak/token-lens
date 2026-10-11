// Self-check: the shared xdev/omp/pi session-log parser and its ingest path.
// Run with: bun run tests/agent-session.test.ts
import { strict as assert } from "assert";
import { openMetricsDb } from "../src/db/schema";
import { parseAgentSessionFile, decodeAgentCwd } from "../src/collector/agent-session";
import { ingestAgentSession } from "../src/collector/agent-backfill";
import {
  capBody,
  getLatencyStats,
  getSessionDetail,
  recomputeRollups,
} from "../src/db/queries";

let passed = 0,
  failed = 0;
const test = async (name: string, fn: () => Promise<void> | void) => {
  try {
    await fn();
    console.log(`  ok  ${name}`);
    passed++;
  } catch (e) {
    console.error(`  FAIL ${name}\n    ${e instanceof Error ? e.message : e}`);
    failed++;
  }
};

// Fixtures are invented: a generic "A --> B" workspace, no real session data.
const L = (o: unknown) => JSON.stringify(o);

/** xdev: assistant carries toolCall parts in content, toolResults follow. */
const XDEV_LOG = [
  L({ type: "session", version: 3, id: "sess-x1", timestamp: "2026-01-02T03:04:05.000Z", cwd: "/tmp/ws" }),
  L({ type: "model_change", id: "m1", parentId: null, timestamp: "2026-01-02T03:04:06.000Z", model: "onegw/xai/grok-4.5" }),
  L({ type: "message", id: "u1", parentId: "m1", timestamp: "2026-01-02T03:04:06.100Z", message: { role: "user", content: [{ type: "text", text: "say pong" }], timestamp: 1767324246100 } }),
  L({ type: "message", id: "a1", parentId: "u1", timestamp: "2026-01-02T03:04:07.200Z", message: { role: "assistant", provider: "onegw", model: "xai/grok-4.5", usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120, reasoningTokens: 0 }, ttft: 800, duration: 2100, content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "echo pong" } }] } }),
  L({ type: "message", id: "r1", parentId: "a1", timestamp: "2026-01-02T03:04:07.400Z", message: { role: "toolResult", toolCallId: "call-1", toolName: "bash", duration: 190, timestamp: 1767324247400, isError: false, content: [{ type: "text", text: "pong" }] } }),
  L({ type: "message", id: "a2", parentId: "r1", timestamp: "2026-01-02T03:04:08.000Z", message: { role: "assistant", provider: "onegw", model: "xai/grok-4.5", usage: { input: 150, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 160 }, duration: 900, content: [{ type: "text", text: "done" }] } }),
].join("\n");

/** omp: tool args live on `custom/tool_execution_start`, not the message. */
const OMP_LOG = [
  L({ type: "session", version: 3, id: "sess-o1", timestamp: "2026-01-02T03:04:05.000Z", cwd: "/tmp/ws" }),
  L({ type: "custom", id: "c1", parentId: null, timestamp: "2026-01-02T03:04:06.000Z", customType: "tool_execution_start", data: { toolCallId: "call_o1", toolName: "read", startedAt: "2026-01-02T03:04:06.000Z", args: { path: "/tmp/a.txt" } } }),
  L({ type: "message", id: "a1", parentId: "c1", timestamp: "2026-01-02T03:04:07.000Z", message: { role: "assistant", api: "openai-completions", provider: "omp", model: "provider/glm-5.3-flash", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0 } }, content: [{ type: "toolCall", id: "call_o1", name: "read" }] } }),
  L({ type: "message", id: "r1", parentId: "a1", timestamp: "2026-01-02T03:04:07.500Z", message: { role: "toolResult", toolCallId: "call_o1", toolName: "read", duration: 60, timestamp: 1767324247500, isError: true, content: [{ type: "text", text: "ENOENT" }] } }),
].join("\n");

/** pi: same envelope as xdev but tool args named `arguments`; a marker-only call. */
const PI_LOG = [
  L({ type: "session", version: 3, id: "sess-p1", timestamp: "2026-01-02T03:04:05.000Z", cwd: "/tmp/ws" }),
  L({ type: "message", id: "a1", parentId: null, timestamp: "2026-01-02T03:04:06.000Z", message: { role: "assistant", provider: "onegw", model: "opencode/space-bunny-free", usage: { input: 300, output: 40, cacheRead: 100, cacheWrite: 0, reasoning: 4, totalTokens: 340 }, stopReason: "tool-use", content: [{ type: "toolCall", id: "call_p1", name: "bash", arguments: { command: "ls" } }] } }),
  L({ type: "custom", id: "c1", parentId: "a1", timestamp: "2026-01-02T03:04:06.500Z", customType: "tool_execution_start", data: { toolCallId: "call_p_never", toolName: "grep", startedAt: "2026-01-02T03:04:06.500Z" } }),
].join("\n");

console.log("agent-session self-check");

await test("decodeAgentCwd maps the dash-encoded sessions dir", () => {
  assert.equal(decodeAgentCwd("-tmp-ws"), "/tmp/ws");
  assert.equal(decodeAgentCwd(""), "");
});

await test("xdev log: turns, usage, tool call with request + response", () => {
  const s = parseAgentSessionFile("/x/sess-x1.jsonl", XDEV_LOG)!;
  assert.equal(s.sessionId, "sess-x1");
  assert.equal(s.cwd, "/tmp/ws");
  assert.equal(s.turns.length, 2, "two assistant messages = two turns");
  assert.equal(s.turns[0]!.ttftMs, 800);
  assert.equal(s.turns[0]!.durationMs, 2100);
  assert.equal(s.turns[1]!.usage.input, 150);
  assert.equal(s.toolCalls.length, 1);
  const call = s.toolCalls[0]!;
  assert.equal(call.use.toolName, "bash");
  assert.equal(call.use.arguments?.command, "echo pong");
  assert.equal(call.result!.durationMs, 190);
  assert.equal(call.result!.isError, false);
  assert.equal(call.result!.text, "pong");
  assert.equal(s.userPrompt, "say pong");
});

await test("omp log: args come from the custom marker, failure is detected", () => {
  const s = parseAgentSessionFile("/o/sess-o1.jsonl", OMP_LOG)!;
  assert.equal(s.turns.length, 1);
  // model keeps the last two path segments so pricing still matches
  assert.equal(s.turns[0]!.model, "provider/glm-5.3-flash");
  assert.equal(s.toolCalls.length, 1);
  assert.equal(s.toolCalls[0]!.use.arguments?.path, "/tmp/a.txt");
  assert.equal(s.toolCalls[0]!.result!.isError, true);
});

await test("pi log: marker-only call with no result is still counted", () => {
  const s = parseAgentSessionFile("/p/sess-p1.jsonl", PI_LOG)!;
  assert.equal(s.toolCalls.length, 2, "one paired + one marker-only");
  const orphan = s.toolCalls.find((c) => c.use.toolCallId === "call_p_never")!;
  assert.equal(orphan.result, null);
  assert.equal(orphan.use.toolName, "grep");
  assert.equal(s.turns[0]!.usage.cacheRead, 100);
});

await test("a non-session file parses to null", () => {
  assert.equal(parseAgentSessionFile("/n.jsonl", '{"type":"something-else"}'), null);
  assert.equal(parseAgentSessionFile("/n.jsonl", "not json at all\n"), null);
});

await test("ingest writes session, turns, snapshots and tool calls", async () => {
  const db = openMetricsDb(":memory:");
  try {
    const parsed = parseAgentSessionFile("/x/sess-x1.jsonl", XDEV_LOG)!;
    ingestAgentSession(db, parsed, ".xdev");
    const session = db
      .query(`SELECT profile, title, workspace, model FROM sessions WHERE conversation_id = ?`)
      .get("sess-x1") as { profile: string; title: string | null; workspace: string | null; model: string | null };
    assert.equal(session.profile, ".xdev");
    assert.equal(session.workspace, "/tmp/ws");

    const turns = db.query(`SELECT generation_id FROM turns WHERE conversation_id = ?`).all("sess-x1");
    assert.equal(turns.length, 2);
    const snap = db.query(`SELECT input_tokens, output_tokens FROM token_snapshots WHERE conversation_id = ? AND generation_id = ?`).all("sess-x1", "a1") as Array<{ input_tokens: number; output_tokens: number }>;
    assert.equal(snap[0]!.input_tokens, 100);
    assert.equal(snap[0]!.output_tokens, 20);

    const call = db
      .query(`SELECT tool_name, duration_ms, request, response FROM tool_calls WHERE conversation_id = ?`)
      .get("sess-x1") as { tool_name: string; duration_ms: number; request: string; response: string };
    assert.equal(call.tool_name, "terminal:echo", "bash+command normalizes to terminal:<cmd>");
    assert.equal(call.duration_ms, 190);
    assert.ok(call.request.includes("echo pong"));
    assert.equal(call.response, "pong");

    // Re-ingesting is idempotent: no duplicate turns or tool calls.
    ingestAgentSession(db, parsed, ".xdev");
    const turnCount = db
      .query(`SELECT COUNT(*) AS n FROM turns WHERE conversation_id = ?`)
      .get("sess-x1") as { n: number };
    assert.equal(turnCount.n, 2);
    const callCount = db
      .query(`SELECT COUNT(*) AS n FROM tool_calls WHERE conversation_id = ?`)
      .get("sess-x1") as { n: number };
    assert.equal(callCount.n, 1);

    const stats = getLatencyStats(db, "sess-x1");
    assert.equal(stats.tool_calls, 1);
    assert.equal(stats.failures, 0);
    // getSessionDetail reads the rollup, which a real backfill writes last.
    await recomputeRollups(db, ["sess-x1"]);
    const detail = getSessionDetail(db, "sess-x1")!;
    assert.ok(detail, "rollup row exists after recomputeRollups");
    assert.equal(detail.tool_calls.length, 1);
    assert.equal(detail.tool_calls[0]!.response, "pong");
  } finally {
    db.close();
  }
});

await test("capBody marks anything over the cap as truncated", () => {
  assert.equal(capBody("short").truncated, false);
  assert.equal(capBody(null).body, null);
  const big = "x".repeat(9000);
  const capped = capBody(big);
  assert.equal(capped.truncated, true);
  assert.ok(capped.body!.length <= 8192);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
