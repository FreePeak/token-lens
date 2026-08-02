import type { Database } from "bun:sqlite";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import {
  insertToolCall,
  recomputeRollups,
  upsertSession,
  upsertTokenSnapshot,
  upsertTurn,
} from "../db/queries";
import { normalizeToolLabel } from "../shared/tools";

/**
 * Claude Code stores one conversation per JSONL file under
 * `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`. The encoded cwd
 * replaces `/` with `-` (so `/Users/foo/bar` → `-Users-foo-bar`).
 */

export const CLAUDE_CODE_PROFILE = ".claude";
export const DEFAULT_CLAUDE_CODE_HOME = join(homedir(), ".claude");

export type ClaudeCodeProjectRoot = {
  /** Absolute path to <claudeHome>/projects */
  projectsDir: string;
  /** Encoded cwd directory name (e.g. `-Users-foo-bar`) */
  encodedDir: string;
  /** Best-effort decoded absolute path for the workspace (display only). */
  decodedDir: string;
};

/**
 * Claude Code's cwd encoding rules: `path` → `path.replace(/\//g, "-")`.
 * Round-trip: drop the leading dash and replace remaining dashes with `/`.
 * Edge case: directory named `-` itself decodes to `/` (matching Claude's behavior).
 */
export function decodeClaudeCodeProjectDir(encoded: string): string {
  if (encoded === "-") return "/";
  if (!encoded.startsWith("-")) return encoded;
  return "/" + encoded.slice(1).replace(/-/g, "/");
}

export function buildClaudeCodeJsonlPath(
  root: ClaudeCodeProjectRoot,
  sessionId: string,
): string {
  return join(root.projectsDir, root.encodedDir, `${sessionId}.jsonl`);
}

/** Find every Claude Code project root inside `claudeHome` (default `~/.claude`). */
export function discoverClaudeCodeRoots(
  claudeHome: string = DEFAULT_CLAUDE_CODE_HOME,
): ClaudeCodeProjectRoot[] {
  const projectsDir = join(claudeHome, "projects");
  if (!existsSync(projectsDir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(projectsDir);
  } catch {
    return [];
  }
  const out: ClaudeCodeProjectRoot[] = [];
  for (const name of entries) {
    const dir = join(projectsDir, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    out.push({
      projectsDir,
      encodedDir: name,
      decodedDir: decodeClaudeCodeProjectDir(name),
    });
  }
  return out;
}

export type ClaudeCodeSessionRef = {
  root: ClaudeCodeProjectRoot;
  sessionId: string;
  jsonlPath: string;
  mtimeMs: number;
};

/**
 * Walk every `<encoded>/<sessionId>.jsonl` under a project root, returning
 * lightweight refs sorted by mtime desc. Recurses so worktree subdirs like
 * `<encoded>--worktrees-<branch>` are picked up too.
 */
export function scanClaudeCodeSessions(projectsDir: string): ClaudeCodeSessionRef[] {
  if (!existsSync(projectsDir)) return [];
  const out: ClaudeCodeSessionRef[] = [];
  const walk = (dir: string, encodedDir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const p = join(dir, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      // Skip symlinks: Claude Code mirrors worktree subdirs as top-level
      // symlinks (e.g. `-Users-x-y-subagents-workflows-wf_x` → nested
      // `wf_x`), and following them double-counts every JSONL. lstat
      // distinguishes link vs dir/file so each real file is visited once.
      if (lstatSync(p).isSymbolicLink()) continue;
      if (st.isDirectory()) {
        // encode the nested path segments so workspace_path stays correct
        walk(p, `${encodedDir}-${name}`);
        continue;
      }
      if (!name.endsWith(".jsonl")) continue;
      const sessionId = name.slice(0, -".jsonl".length);
      out.push({
        root: {
          projectsDir,
          encodedDir,
          decodedDir: decodeClaudeCodeProjectDir(encodedDir),
        },
        sessionId,
        jsonlPath: p,
        mtimeMs: st.mtimeMs,
      });
    }
  };
  for (const encoded of readdirSync(projectsDir)) {
    const dir = join(projectsDir, encoded);
    let st;
    try {
      // lstat: skip worktree-mirror symlinks (they point into the real tree)
      if (lstatSync(dir).isSymbolicLink()) continue;
      st = statSync(dir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    walk(dir, encoded);
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

type AssistantUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

type ClaudeRecord = {
  type?: string;
  uuid?: string;
  parentUuid?: string | null;
  sessionId?: string;
  cwd?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: string | Array<{
      type?: string;
      text?: string;
      thinking?: string;
      id?: string;
      name?: string;
      input?: unknown;
      tool_use_id?: string;
      content?: unknown;
      is_error?: boolean;
    }>;
    model?: string;
    usage?: AssistantUsage;
  };
};

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function tsMs(v: string | undefined): number | null {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const c of content) {
    if (c && typeof c === "object") {
      const t = (c as { text?: string }).text;
      if (typeof t === "string") parts.push(t);
    }
  }
  return parts.join("\n").trim();
}

function toolDisplayName(name: string, input: unknown): string {
  const params = typeof input === "string" ? input : input != null ? JSON.stringify(input) : null;
  return normalizeToolLabel(name, { params });
}

export type ParseResult = { ok: boolean; reason?: string };

/** Parse one Claude Code JSONL session and write metrics rows. */
export function parseClaudeCodeSessionFile(
  metricsDb: Database,
  jsonlPath: string,
  root: ClaudeCodeProjectRoot,
): ParseResult {
  let raw: string;
  try {
    raw = readFileSync(jsonlPath, "utf8");
  } catch (err) {
    return { ok: false, reason: `read failed: ${(err as Error).message}` };
  }
  // Skip empty / trivially short files (e.g. wrapper zero-byte tail writes).
  if (!raw.trim()) return { ok: false, reason: "empty" };

  const lines = raw.split("\n");
  let sessionId: string | null = null;
  let cwd: string | null = root.decodedDir;
  let startedAt: number | null = null;
  let lastTs: number | null = null;
  let model: string | null = null;
  let firstPrompt: string | null = null;
  let lastPrompt: string | null = null;

  type InsertOrder = Array<() => void>;
  const writes: InsertOrder = [];
  let userCount = 0;
  let assistantCount = 0;
  let toolSeen = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    let rec: ClaudeRecord;
    try {
      rec = JSON.parse(line) as ClaudeRecord;
    } catch {
      continue;
    }
    if (rec.sessionId) sessionId = sessionId ?? rec.sessionId;
    if (rec.cwd) cwd = rec.cwd;
    const ts = tsMs(rec.timestamp);
    if (ts != null) {
      if (startedAt == null || ts < startedAt) startedAt = ts;
      if (lastTs == null || ts > lastTs) lastTs = ts;
    }

    const type = rec.type;
    if (type !== "user" && type !== "assistant") continue;

    const messageContent = rec.message?.content;
    if (type === "user") {
      // queue-operation messages never have `message.role: "user"` and no
      // content blocks; bypass the text extraction for those.
      const isToolResult =
        Array.isArray(messageContent) &&
        messageContent.some((c) => c?.type === "tool_result");
      const text = textFromContent(messageContent);
      if (!isToolResult && text) {
        const cleaned = text.replace(/\s+/g, " ").trim();
        if (cleaned) {
          lastPrompt = cleaned.slice(0, 240);
          if (firstPrompt == null) firstPrompt = lastPrompt;
        }
        userCount++;
        const genId = rec.uuid ?? `user-${i}`;
        const at = ts ?? lastTs ?? Date.now();
        writes.push(() =>
          upsertTurn(metricsDb, {
            conversation_id: sessionId ?? "unknown",
            generation_id: genId,
            status: "user",
            ended_at: at,
          }),
        );
      }
      continue;
    }

    // assistant
    const usage = rec.message?.usage ?? {};
    const input = num(usage.input_tokens);
    const output = num(usage.output_tokens);
    const cacheRead = num(usage.cache_read_input_tokens);
    const cacheWrite = num(usage.cache_creation_input_tokens);
    if (rec.message?.model) model = model ?? rec.message.model;

    assistantCount++;
    const id = sessionId ?? "unknown";
    const at = ts ?? lastTs ?? Date.now();
    const snapGen = rec.uuid ?? `assist-${i}`;
    if (input > 0 || output > 0 || cacheRead > 0 || cacheWrite > 0) {
      writes.push(() =>
        upsertTokenSnapshot(metricsDb, {
          conversation_id: id,
          bubble_id: `cc:${snapGen}`,
          generation_id: snapGen,
          input_tokens: input,
          output_tokens: output,
          cache_read_tokens: cacheRead,
          cache_write_tokens: cacheWrite,
          model: rec.message?.model ?? null,
          created_at: at,
          estimated: false,
          prompt: lastPrompt,
        }),
      );
    } else {
      // Still record turn + first non-empty assistant text we see
      // (empty usage = streaming-end placeholder; skip empty content)
      writes.push(() =>
        upsertTurn(metricsDb, {
          conversation_id: id,
          generation_id: snapGen,
          status: "responded",
          ended_at: at,
        }),
      );
    }

    const blocks = Array.isArray(messageContent) ? messageContent : [];
    for (const block of blocks) {
      if (!block || typeof block !== "object") continue;
      const b = block as { type?: string; name?: string; id?: string; input?: unknown };
      if (b.type === "tool_use" && typeof b.name === "string" && b.name) {
        const label = toolDisplayName(b.name, b.input);
        const dedupe = `${snapGen}:${label}`;
        if (toolSeen.has(dedupe)) continue;
        toolSeen.add(dedupe);
        writes.push(() =>
          insertToolCall(metricsDb, {
            conversation_id: id,
            generation_id: snapGen,
            tool_name: label,
            success: true,
            created_at: at,
          }),
        );
      }
    }
  }

  if (!sessionId) return { ok: false, reason: "no sessionId in file" };
  const totalTurns = userCount + assistantCount;
  const duration =
    startedAt != null && lastTs != null && lastTs >= startedAt
      ? lastTs - startedAt
      : null;

  metricsDb.transaction(() => {
    upsertSession(metricsDb, {
      conversation_id: sessionId!,
      title: firstPrompt,
      workspace: root.encodedDir,
      workspace_path: cwd ?? root.decodedDir,
      model,
      started_at: startedAt,
      ended_at: lastTs,
      duration_ms: duration,
      source: "backfill",
      first_prompt: firstPrompt,
      profile: CLAUDE_CODE_PROFILE,
      last_backfilled_at: lastTs ?? Date.now(),
    });
    for (const w of writes) w();
  })();

  return { ok: true };
}

export type ClaudeCodeBackfillResult = {
  sessions: number;
  changed: number;
  toolCalls: number;
  bubbles: number;
};

/**
 * Discover Claude Code sessions and insert them into `metricsDb`.
 * `resume: true` re-imports changed files (slower; same content twice is a no-op
 * for token snapshots). The function is idempotent.
 */
export async function backfillClaudeCode(
  metricsDb: Database,
  opts: { resume?: boolean; claudeHome?: string } = {},
): Promise<ClaudeCodeBackfillResult> {
  const claudeHome = opts.claudeHome ?? DEFAULT_CLAUDE_CODE_HOME;
  const roots = discoverClaudeCodeRoots(claudeHome);
  // Every root shares the same `projectsDir`; scan each unique projects dir
  // once so a session is never parsed N times (N = project dirs under it).
  const refs: ClaudeCodeSessionRef[] = [];
  for (const projectsDir of new Set(roots.map((r) => r.projectsDir))) {
    refs.push(...scanClaudeCodeSessions(projectsDir));
  }

  if (!refs.length) {
    return { sessions: 0, changed: 0, toolCalls: 0, bubbles: 0 };
  }

  let toolCalls = 0;
  let bubbles = 0;
  const touched: string[] = [];
  for (const ref of refs) {
    const r = parseClaudeCodeSessionFile(metricsDb, ref.jsonlPath, ref.root);
    if (!r.ok) continue;
    // We don't have a per-bubble count exposed (writes happen via writes.push),
    // so derive from DB before/after is heavy. Use DB counters via tool/token tables instead.
    if (ref.sessionId) touched.push(ref.sessionId);
  }
  // Quick counts from DB after writes
  const counts = metricsDb
    .query(
      `SELECT
        (SELECT COUNT(*) FROM sessions WHERE profile = ?) AS sessions,
        (SELECT COUNT(*) FROM tool_calls c JOIN sessions s ON s.conversation_id = c.conversation_id WHERE s.profile = ?) AS tool_calls,
        (SELECT COUNT(*) FROM token_snapshots t JOIN sessions s ON s.conversation_id = t.conversation_id WHERE s.profile = ? AND t.bubble_id LIKE 'cc:%') AS bubbles`,
    )
    .all(CLAUDE_CODE_PROFILE, CLAUDE_CODE_PROFILE, CLAUDE_CODE_PROFILE) as Array<{
    sessions: number;
    tool_calls: number;
    bubbles: number;
  }>;
  const c = counts[0] ?? { sessions: 0, tool_calls: 0, bubbles: 0 };
  toolCalls = c.tool_calls;
  bubbles = c.bubbles;

  if (touched.length) await recomputeRollups(metricsDb, touched);
  return { sessions: c.sessions, changed: refs.length, toolCalls, bubbles };
  // opts.resume: currently treated identically to full. A future pass could
  // skip files whose mtime <= last_backfilled_at; left for parity with Cursor.
  void opts;
}
