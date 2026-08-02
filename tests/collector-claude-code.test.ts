// Self-check: Claude Code JSONL parser produces sessions, tokens, turns, and tool calls.
// Run with: bun run tests/collector-claude-code.test.ts
import { strict as assert } from "assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Database } from "bun:sqlite";
import { openMetricsDb } from "../src/db/schema";
import {
  buildClaudeCodeJsonlPath,
  decodeClaudeCodeProjectDir,
  discoverClaudeCodeRoots,
  parseClaudeCodeSessionFile,
  scanClaudeCodeSessions,
  type ClaudeCodeProjectRoot,
} from "../src/collector/claude-code";

let passed = 0;
let failed = 0;
const test = async (name: string, fn: () => Promise<void> | void): Promise<void> => {
  try {
    await fn();
    console.log(`  ok  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL ${name}\n    ${err instanceof Error ? err.message : err}`);
    failed++;
  }
};

function newDb(): Database {
  return openMetricsDb(":memory:");
}

function writeJsonl(path: string, rows: Array<Record<string, unknown>>): void {
  const lines = rows.map((r) => JSON.stringify(r)).join("\n");
  writeFileSync(path, lines, "utf8");
}

function userRow(text: string, sessionId = "sess-1", cwd = "/Users/x/y"): Record<string, unknown> {
  return {
    type: "user",
    sessionId,
    cwd,
    timestamp: "2026-07-31T10:00:00.000Z",
    uuid: `u-${text.length}-${Math.random()}`,
    parentUuid: null,
    message: { role: "user", content: text },
  };
}

function assistantRow(
  usage: { input: number; output: number; cacheRead?: number; cacheWrite?: number },
  blocks: Array<Record<string, unknown>>,
  opts: { sessionId?: string; model?: string; timestamp?: string } = {},
): Record<string, unknown> {
  const tokens = {
    input_tokens: usage.input,
    output_tokens: usage.output,
    cache_read_input_tokens: usage.cacheRead ?? 0,
    cache_creation_input_tokens: usage.cacheWrite ?? 0,
  };
  return {
    type: "assistant",
    sessionId: opts.sessionId ?? "sess-1",
    cwd: "/Users/x/y",
    timestamp: opts.timestamp ?? "2026-07-31T10:00:01.000Z",
    uuid: `a-${Math.random()}`,
    parentUuid: null,
    message: {
      role: "assistant",
      content: blocks,
      model: opts.model ?? "claude-sonnet-4-5-20250929",
      usage: tokens,
    },
  };
}

console.log("collector-claude-code self-check");

await test("decodes project dir names back to a workspace path", () => {
  // /Users/x/y becomes -Users-x-y
  assert.equal(decodeClaudeCodeProjectDir("-Users-x-y"), "/Users/x/y");
  assert.equal(decodeClaudeCodeProjectDir("-"), "/");
  assert.equal(decodeClaudeCodeProjectDir("-private-tmp"), "/private/tmp");
  // No leading dash → unknown, return as-is
  assert.equal(decodeClaudeCodeProjectDir("plain"), "plain");
});

await test("buildClaudeCodeJsonlPath joins encoded project dir + session id", () => {
  const root: ClaudeCodeProjectRoot = {
    projectsDir: "/Users/x/.claude/projects",
    encodedDir: "-Users-x-y",
    decodedDir: "/Users/x/y",
  };
  const p = buildClaudeCodeJsonlPath(root, "abc-123");
  assert.equal(p, join("/Users/x/.claude/projects", "-Users-x-y", "abc-123.jsonl"));
});

await test("parseClaudeCodeSessionFile captures model, usage, turns, and tool calls", () => {
  const root: ClaudeCodeProjectRoot = {
    projectsDir: "/tmp/.claude/projects",
    encodedDir: "-Users-x-y",
    decodedDir: "/Users/x/y",
  };
  const dir = mkdtempSync(join(tmpdir(), "claudecode-"));
  try {
    const file = join(dir, "sess-1.jsonl");
    writeJsonl(file, [
      userRow("hello there", "sess-1"),
      assistantRow(
        { input: 50, output: 20, cacheRead: 10, cacheWrite: 5 },
        [
          { type: "text", text: "hi!" },
          { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
        ],
        { sessionId: "sess-1" },
      ),
      {
        type: "user",
        sessionId: "sess-1",
        cwd: "/Users/x/y",
        timestamp: "2026-07-31T10:00:02.000Z",
        uuid: "u-2",
        parentUuid: "a-1",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok", is_error: false }] },
      },
      assistantRow(
        { input: 80, output: 30 },
        [{ type: "text", text: "done" }],
        { sessionId: "sess-1", timestamp: "2026-07-31T10:00:03.000Z" },
      ),
    ]);

    const db = newDb();
    try {
      const r = parseClaudeCodeSessionFile(db, file, root);
      assert.equal(r.ok, true);
      const sess = db.query(`SELECT conversation_id, model, profile, workspace_path, first_prompt FROM sessions WHERE conversation_id = ?`).get("sess-1") as Record<string, unknown> | null;
      assert.ok(sess, "session row exists");
      assert.equal(sess!.model, "claude-sonnet-4-5-20250929");
      assert.equal(sess!.profile, ".claude");
      assert.equal(sess!.workspace_path, "/Users/x/y");
      assert.equal(sess!.first_prompt, "hello there");
      const snaps = db.query(`SELECT input_tokens, output_tokens, cache_read_tokens, cache_write_tokens FROM token_snapshots WHERE conversation_id = ? ORDER BY created_at`).all("sess-1") as Array<{ input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number }>;
      assert.equal(snaps.length, 2);
      assert.equal(snaps[0]!.input_tokens, 50);
      assert.equal(snaps[0]!.output_tokens, 20);
      assert.equal(snaps[0]!.cache_read_tokens, 10);
      assert.equal(snaps[0]!.cache_write_tokens, 5);
      assert.equal(snaps[1]!.input_tokens, 80);
      assert.equal(snaps[1]!.output_tokens, 30);
      const tools = db.query(`SELECT tool_name FROM tool_calls WHERE conversation_id = ? ORDER BY id`).all("sess-1") as Array<{ tool_name: string }>;
      assert.deepEqual(tools.map((t) => t.tool_name), ["terminal:ls"]);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test("scanClaudeCodeSessions visits all .jsonl files under projects dir", () => {
  const dir = mkdtempSync(join(tmpdir(), "claudecode-roots-"));
  try {
    const projects = join(dir, "projects");
    const subA = join(projects, "-Users-a-b");
    const subB = join(projects, "-Users-c-d");
    mkdirSync(subA, { recursive: true });
    mkdirSync(subB, { recursive: true });
    writeJsonl(join(subA, "s1.jsonl"), [userRow("p1", "s1", "/a/b")]);
    writeJsonl(join(subA, "s2.jsonl"), [userRow("p2", "s2", "/a/b")]);
    writeJsonl(join(subB, "s3.jsonl"), [userRow("p3", "s3", "/c/d")]);
    writeFileSync(join(subA, "notes.txt"), "ignore me");

    const roots = discoverClaudeCodeRoots(dir);
    assert.equal(roots.length, 2, "two encoded project dirs under one projects/");
    assert.equal(roots[0]!.projectsDir, projects);
    const sessions = scanClaudeCodeSessions(roots[0]!.projectsDir);
    const ids = sessions.map((s) => s.sessionId).sort();
    assert.deepEqual(ids, ["s1", "s2", "s3"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test("empty Claude Code install is a no-op (zero rows)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "claudecode-empty-"));
  try {
    const projects = join(dir, "projects");
    mkdirSync(projects, { recursive: true });
    const db = newDb();
    try {
      const { backfillClaudeCode } = await import("../src/collector/claude-code");
      const r = await backfillClaudeCode(db, { claudeHome: dir });
      assert.equal(r.sessions, 0);
      assert.equal(r.toolCalls, 0);
      assert.equal(r.bubbles, 0);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test("queue-operation records do not count as user turns", () => {
  const db = newDb();
  try {
    const root: ClaudeCodeProjectRoot = {
      projectsDir: "/tmp",
      encodedDir: "-Users-x-y",
      decodedDir: "/Users/x/y",
    };
    const dir = mkdtempSync(join(tmpdir(), "claudecode-q-"));
    try {
      const file = join(dir, "s.jsonl");
      writeJsonl(file, [
        { type: "queue-operation", operation: "enqueue", sessionId: "s", timestamp: "2026-01-01T00:00:00Z", content: "x" },
        { type: "queue-operation", operation: "dequeue", sessionId: "s", timestamp: "2026-01-01T00:00:00Z" },
        userRow("real prompt", "s"),
      ]);
      parseClaudeCodeSessionFile(db, file, root);
      const turns = db.query(`SELECT generation_id, status FROM turns WHERE conversation_id = ?`).all("s") as Array<{ generation_id: string; status: string }>;
      assert.equal(turns.length, 1);
      assert.equal(turns[0]!.status, "user");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    db.close();
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
