import type { Database } from "bun:sqlite";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import {
  insertToolCall,
  recomputeRollups,
  upsertSession,
  upsertTokenSnapshot,
  upsertTurn,
} from "../db/queries";
import { normalizeToolLabel } from "../shared/tools";
import { parseAgentSessionFile, type AgentRoot, type ParsedSession } from "./agent-session";

/**
 * Backfill one agent's `<agent>/sessions/**` JSONL logs into the metrics DB.
 * Idempotent: sessions are re-parsed on every run (a resumed session keeps
 * growing), and each row is upserted by its stable session id.
 */

/** Files written within this window may still be growing — skip them. */
const LIVE_WINDOW_MS = 60_000;
/** Skip absurdly large logs; a session that big is not worth the parse cost. */
const MAX_FILE_BYTES = 64 * 1024 * 1024;

export type AgentScan = { sessions: number; turns: number; toolCalls: number };

type FileRef = { path: string; encodedDir: string; mtimeMs: number };

/** Walk <sessionsDir>/<encoded-cwd>/*.jsonl, skipping lock/owner sidecars. */
export function scanAgentSessionFiles(sessionsDir: string): FileRef[] {
  const out: FileRef[] = [];
  let entries: string[];
  try {
    entries = readdirSync(sessionsDir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const dir = join(sessionsDir, entry);
    let names: string[];
    try {
      if (!statSync(dir).isDirectory()) continue;
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(dir, name);
      try {
        const st = statSync(path);
        if (st.size === 0) continue;
        out.push({ path, encodedDir: entry, mtimeMs: st.mtimeMs });
      } catch {
        /* raced delete */
      }
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** Write one parsed session. Returns the conversation id for rollup recompute. */
export function ingestAgentSession(db: Database, parsed: ParsedSession, profile: string): string {
  const id = parsed.sessionId;
  const startedAt =
    parsed.startedAt ?? (parsed.turns.length ? parsed.turns[0]!.timestamp : Date.now());

  upsertSession(db, {
    conversation_id: id,
    title: parsed.title,
    workspace: parsed.cwd,
    workspace_path: parsed.cwd,
    source_path: parsed.sourcePath,
    model: parsed.turns.find((t) => t.model)?.model ?? null,
    started_at: startedAt,
    ended_at: parsed.endedAt ?? null,
    duration_ms:
      parsed.endedAt != null && startedAt != null ? Math.max(0, parsed.endedAt - startedAt) : null,
    source: "backfill",
    first_prompt: parsed.userPrompt,
    profile,
    last_backfilled_at: Date.now(),
  });

  // Re-import is a replace: clear this session's rows so a resumed session log
  // (which grows) never accumulates duplicates.
  db.run(`DELETE FROM tool_calls WHERE conversation_id = ?`, [id]);

  const inT = parsed.turns.reduce((n, t) => n + t.usage.input, 0);
  const outT = parsed.turns.reduce((n, t) => n + t.usage.output, 0);
  const crT = parsed.turns.reduce((n, t) => n + t.usage.cacheRead, 0);
  const cwT = parsed.turns.reduce((n, t) => n + t.usage.cacheWrite, 0);

  for (const turn of parsed.turns) {
    const anyTokens = inT + outT + crT + cwT > 0;
    upsertTurn(db, {
      conversation_id: id,
      generation_id: turn.id,
      status: turn.toolUses.length ? "tool_use" : "responded",
      started_at: turn.timestamp,
      ended_at: turn.timestamp + (turn.durationMs ?? 0),
    });
    if (anyTokens && turn.usage.input + turn.usage.output > 0) {
      upsertTokenSnapshot(db, {
        conversation_id: id,
        bubble_id: `agent:${turn.id}`,
        generation_id: turn.id,
        input_tokens: turn.usage.input,
        output_tokens: turn.usage.output,
        cache_read_tokens: turn.usage.cacheRead,
        cache_write_tokens: turn.usage.cacheWrite,
        context_tokens: turn.usage.input + turn.usage.cacheRead,
        model: turn.model,
        created_at: turn.timestamp,
        estimated: false,
      });
    }
  }

  for (const call of parsed.toolCalls) {
    const args = call.use.arguments;
    const params = args ? JSON.stringify(args) : null;
    insertToolCall(db, {
      conversation_id: id,
      generation_id: call.turnId || null,
      tool_name: normalizeToolLabel(call.use.toolName, { params }),
      duration_ms: call.result?.durationMs ?? null,
      ttfb_ms:
        call.result?.startedAt != null && call.use.startedAt != null
          ? Math.max(0, call.result.startedAt - call.use.startedAt)
          : null,
      success: call.result ? call.result.isError !== true : false,
      created_at: call.result?.startedAt ?? call.use.startedAt ?? startedAt ?? Date.now(),
      request: params,
      response: call.result ? call.result.text : null,
    });
  }

  return id;
}

export async function backfillAgent(
  db: Database,
  root: AgentRoot,
): Promise<AgentScan> {
  const files = scanAgentSessionFiles(root.sessionsDir);
  const now = Date.now();
  const touched: string[] = [];
  let turns = 0;
  let toolCalls = 0;

  for (const file of files) {
    if (now - file.mtimeMs < LIVE_WINDOW_MS) continue; // still being written
    try {
      if (statSync(file.path).size > MAX_FILE_BYTES) continue;
      const text = readFileSync(file.path, "utf8");
      const parsed = parseAgentSessionFile(file.path, text);
      if (!parsed) continue;
      const id = ingestAgentSession(db, parsed, root.profile);
      turns += parsed.turns.length;
      toolCalls += parsed.toolCalls.length;
      if (!touched.includes(id)) touched.push(id);
    } catch (err) {
      console.error(`[token-lens ${root.kind}] ${file.path}: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (touched.length) await recomputeRollups(db, touched);
  return { sessions: touched.length, turns, toolCalls };
}

/** Exported for the self-check test: one ingest path used by the CLI. */
export function readAgentSessionFile(path: string): ParsedSession | null {
  try {
    return parseAgentSessionFile(path, readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}
