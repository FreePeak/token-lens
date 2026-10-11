import { existsSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";

/**
 * Session-log backfill for agents that store one JSONL per session.
 *
 * xdev, omp and pi share the same on-disk contract (a `type:"session"` header
 * with `version:3`, `id`, `timestamp`, `cwd`, then `type:"message"` lines whose
 * `message.role` is user | assistant | toolResult, each line linked by
 * id/parentId), so one parser covers all three. Claude Code is handled by its
 * own collector (`claude-code.ts`) because its line shapes differ.
 *
 * A turn = one assistant message. Tool calls = assistant `content[]` toolCall
 * parts (or omp's `custom/tool_execution_start` marker) paired with the
 * follow-up `role:"toolResult"` by `toolCallId`.
 */

export const XDEV_PROFILE = ".xdev";
export const OMP_PROFILE = ".omp";
export const PI_PROFILE = ".pi";

export type AgentKind = "xdev" | "omp" | "pi";

export type AgentRoot = {
  /** Stable id used as the `sessions.profile` value. */
  profile: string;
  kind: AgentKind;
  /** Display name for the dashboard. */
  displayName: string;
  /** Absolute path to the `<agent>/sessions` directory. */
  sessionsDir: string;
};

function sessionsDir(home: string, kind: AgentKind): string {
  if (kind === "xdev") return join(homedir(), ".xdev", "agent", "sessions");
  if (kind === "omp") return join(homedir(), ".omp", "agent", "sessions");
  return join(homedir(), ".pi", "agent", "sessions");
}

/** Discover every agent that actually has a sessions dir with JSONL in it. */
export function discoverAgentRoots(): AgentRoot[] {
  const out: AgentRoot[] = [];
  for (const [kind, profile, displayName] of [
    ["xdev", XDEV_PROFILE, "xdev"],
    ["omp", OMP_PROFILE, "omp"],
    ["pi", PI_PROFILE, "pi"],
  ] as Array<[AgentKind, string, string]>) {
    const dir = sessionsDir(homedir(), kind);
    if (!existsSync(dir)) continue;
    out.push({ profile, kind, displayName, sessionsDir: dir });
  }
  return out;
}

/** Embedded-cwd directory name → best-effort decoded path (display only). */
export function decodeAgentCwd(encoded: string): string {
  if (!encoded) return "";
  const stripped = encoded.startsWith("-") ? encoded.slice(1) : encoded;
  return "/" + stripped.split("-").join("/");
}

export type ToolUse = {
  toolCallId: string;
  toolName: string;
  arguments: Record<string, unknown> | null;
  startedAt: number | null;
};

export type ToolResult = {
  toolCallId: string;
  toolName: string;
  durationMs: number | null;
  startedAt: number | null;
  isError: boolean;
  text: string;
};

export type AssistantTurn = {
  /** Line id of the assistant message — the turn's generation id. */
  id: string;
  model: string | null;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    reasoning: number;
  };
  ttftMs: number | null;
  durationMs: number | null;
  timestamp: number;
  text: string;
  toolUses: ToolUse[];
  /** Root-cause reason when the turn ended in an error. */
  stopError: string | null;
};

export type ParsedSession = {
  sessionId: string;
  cwd: string | null;
  title: string | null;
  startedAt: number | null;
  endedAt: number | null;
  turns: AssistantTurn[];
  toolCalls: Array<{ turnId: string; use: ToolUse; result: ToolResult | null }>;
  toolCallCount: number;
  userPrompt: string | null;
  sourcePath: string;
};

type RawLine = Record<string, unknown>;

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function isoMs(v: unknown): number | null {
  const s = str(v);
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

/** Flatten a `content[]` array (or plain string) to plain text. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const p = part as Record<string, unknown>;
    if (typeof p.text === "string") parts.push(p.text);
  }
  return parts.join("\n");
}

/** Compact JSON string for storing a tool request/response body. */
function jsonish(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return null;
  }
}

function normalizeModel(model: unknown): string | null {
  const m = str(model);
  if (!m) return null;
  // pi records bare ids; omp/xdev prefix with provider ("onegw/xai/grok-4.5").
  // Keep the last two segments so the pricing lookup still matches.
  const parts = m.split("/");
  if (parts.length <= 2) return m;
  return parts.slice(-2).join("/");
}

/**
 * Parse one session-log JSONL file.
 * Returns null when the file is not a session log (no `type:"session"` header).
 */
export function parseAgentSessionFile(path: string, text: string): ParsedSession | null {
  const lines = text.split("\n");
  let sessionId: string | null = null;
  let cwd: string | null = null;
  let title: string | null = null;
  let startedAt: number | null = null;
  let endedAt: number | null = null;
  let firstUserPrompt: string | null = null;

  const turns: AssistantTurn[] = [];
  /** toolCallId → pending call, filled from tool_execution_start markers. */
  const pending = new Map<string, ToolUse>();
  const resolved: Array<{ turnId: string; use: ToolUse; result: ToolResult | null }> = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let raw: RawLine;
    try {
      raw = JSON.parse(trimmed) as RawLine;
    } catch {
      continue; // torn final line while the session is still being written
    }
    const ts = isoMs(raw.timestamp) ?? null;

    switch (raw.type) {
      case "session": {
        sessionId = str(raw.id) ?? sessionId;
        cwd = str(raw.cwd) ?? cwd;
        title = str(raw.title) ?? title;
        startedAt = ts ?? startedAt;
        break;
      }
      case "title": {
        title = str(raw.title) ?? title;
        break;
      }
      case "custom": {
        if (raw.customType !== "tool_execution_start") break;
        const data = (raw.data ?? {}) as Record<string, unknown>;
        const id = str(data.toolCallId);
        if (!id) break;
        pending.set(id, {
          toolCallId: id,
          toolName: str(data.toolName) ?? "unknown",
          arguments: (data.args as Record<string, unknown> | undefined) ?? null,
          startedAt: isoMs(data.startedAt) ?? ts,
        });
        break;
      }
      case "message": {
        const msg = (raw.message ?? {}) as Record<string, unknown>;
        const role = str(msg.role);
        const id = str(raw.id) ?? "";
        const tsMs = num(msg.timestamp) || ts || 0;

        if (role === "user") {
          if (!firstUserPrompt) {
            const t = contentText(msg.content).trim();
            if (t) firstUserPrompt = t.replace(/\s+/g, " ").slice(0, 240);
          }
          break;
        }
        if (role === "toolResult") {
          const callId = str(msg.toolCallId) ?? "";
          if (!callId) break;
          const use = pending.get(callId) ?? {
            toolCallId: callId,
            toolName: str(msg.toolName) ?? "unknown",
            arguments: null,
            startedAt: null,
          };
          // The result line itself carries nothing but the id; recover the
          // arguments from the turn that issued the call so we can store them.
          if (use.arguments == null) {
            for (const turn of turns) {
              const match = turn.toolUses.find((u) => u.toolCallId === callId);
              if (match) {
                use.arguments = match.arguments;
                break;
              }
            }
          }
          resolved.push({
            turnId: "",
            use,
            result: {
              toolCallId: callId,
              toolName: str(msg.toolName) ?? use.toolName,
              durationMs: typeof msg.duration === "number" ? msg.duration : null,
              startedAt: typeof msg.timestamp === "number" ? msg.timestamp : ts,
              isError: msg.isError === true,
              text: contentText(msg.content),
            },
          });
          break;
        }
        if (role !== "assistant") break;

        const usage = (msg.usage ?? {}) as Record<string, unknown>;
        const toolUses: ToolUse[] = [];
        const contentParts = Array.isArray(msg.content) ? msg.content : [];
        let text = "";
        for (const part of contentParts) {
          if (!part || typeof part !== "object") continue;
          const p = part as Record<string, unknown>;
          if (p.type === "toolCall") {
            toolUses.push({
              toolCallId: str(p.id) ?? "",
              toolName: str(p.name) ?? "unknown",
              arguments:
                (p.arguments as Record<string, unknown> | undefined) ??
                (p.args as Record<string, unknown> | undefined) ??
                null,
            });
          } else if (typeof p.text === "string") {
            text += (text ? "\n" : "") + p.text;
          }
        }
        const turn: AssistantTurn = {
          id,
          model: normalizeModel(msg.model),
          usage: {
            input: num(usage.input),
            output: num(usage.output),
            cacheRead: num(usage.cacheRead),
            cacheWrite: num(usage.cacheWrite),
            reasoning: num(usage.reasoning ?? usage.reasoningTokens),
          },
          ttftMs: typeof msg.ttft === "number" ? msg.ttft : null,
          durationMs: typeof msg.duration === "number" ? msg.duration : null,
          timestamp: tsMs,
          text,
          toolUses,
          stopError: str(msg.error) ?? null,
        };
        turns.push(turn);
        endedAt = tsMs > 0 ? tsMs : endedAt;
        break;
      }
      default:
        break;
    }
  }

  if (!sessionId) return null;

  // Attach each tool result to the turn that issued the call. Any marker call
  // that never produced a result is still a call (the tool ran, we just have
  // no outcome), so it stays in the list with `result: null`.
  const issued = new Set(turns.flatMap((t) => t.toolUses.map((u) => u.toolCallId)));
  const out: Array<{ turnId: string; use: ToolUse; result: ToolResult | null }> = [];
  // Message-part calls that never produced a result line still belong in the
  // list (the tool ran, we just have no outcome).
  for (const turn of turns) {
    for (const use of turn.toolUses) {
      if (!resolved.some((r) => r.use.toolCallId === use.toolCallId)) {
        out.push({ turnId: turn.id, use, result: null });
      }
    }
  }
  for (const r of resolved) {
    // A result follows its issuing turn in the chain; match by the newest turn
    // that declared the call, falling back to the last assistant turn.
    let owner = "";
    for (const turn of turns) {
      if (turn.toolUses.some((u) => u.toolCallId === r.use.toolCallId)) owner = turn.id;
    }
    r.turnId = owner || turns[turns.length - 1]?.id || "";
    out.push(r);
  }
  for (const [callId, use] of pending) {
    if (issued.has(callId)) continue;
    out.push({ turnId: turns[turns.length - 1]?.id ?? "", use, result: null });
  }

  const toolCalls = out.sort((a, b) => {
    const at = a.result?.startedAt ?? a.use.startedAt ?? 0;
    const bt = b.result?.startedAt ?? b.use.startedAt ?? 0;
    return at - bt;
  });

  return {
    sessionId,
    cwd,
    title,
    startedAt,
    endedAt,
    turns,
    toolCalls,
    toolCallCount: turns.reduce((n, t) => n + t.toolUses.length, 0) + pending.size,
    userPrompt: firstUserPrompt,
    sourcePath: path,
  };
}

/** Total size of a session log, used to skip enormous files mid-write. */
export function sessionFileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** JSON-encode a tool request for storage (augments normalizeToolLabel input). */
export function toolRequestBody(args: Record<string, unknown> | null): string | null {
  return args ? jsonish(args) : null;
}
