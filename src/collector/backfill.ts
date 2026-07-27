import { Database } from "bun:sqlite";
import {
  insertToolCall,
  recomputeAllRollups,
  upsertSession,
  upsertTokenSnapshot,
  upsertTurn,
} from "../db/queries";
import { cursorStateDbPath } from "../db/schema";
import { charsToTokens, contentChars } from "../shared/tools";

type ComposerHeader = {
  composerId?: string;
  name?: string;
  subtitle?: string;
  createdAt?: number;
  lastUpdatedAt?: number;
  unifiedMode?: string;
  workspaceIdentifier?: { id?: string } | string;
};

type Bubble = {
  type?: number | string;
  tokenCount?: { inputTokens?: number; outputTokens?: number };
  contextWindowStatusAtCreation?: { tokensUsed?: number };
  modelInfo?: { modelName?: string };
  text?: string;
  richText?: string;
  toolFormerData?: {
    name?: string;
    tool?: number | string;
    rawArgs?: string;
    result?: unknown;
    status?: string;
  };
  toolResults?: Array<{ toolName?: string; name?: string }>;
  allThinkingBlocks?: Array<string | { text?: string; content?: string }>;
  requestId?: string;
  createdAt?: number | string;
  capabilityType?: number;
};

function decodeValue(v: unknown): string {
  if (typeof v === "string") return v;
  if (v instanceof Uint8Array) return new TextDecoder().decode(v);
  if (Buffer.isBuffer(v)) return v.toString("utf8");
  return String(v ?? "");
}

function workspaceFromHeader(h: ComposerHeader): string | null {
  const w = h.workspaceIdentifier;
  if (!w) return null;
  if (typeof w === "string") return w;
  return w.id ?? null;
}

function openCursorDb(path: string): Database {
  return new Database(`file:${path}?mode=ro`, { readonly: true, create: false });
}

function thinkingChars(blocks: Bubble["allThinkingBlocks"]): number {
  if (!blocks?.length) return 0;
  let n = 0;
  for (const b of blocks) {
    if (typeof b === "string") n += b.length;
    else if (b && typeof b === "object") n += (b.text ?? b.content ?? "").length;
  }
  return n;
}

function toolPayloadChars(tf: Bubble["toolFormerData"]): number {
  if (!tf) return 0;
  let n = (tf.rawArgs ?? "").length;
  if (tf.result != null) {
    n += typeof tf.result === "string" ? tf.result.length : JSON.stringify(tf.result).length;
  }
  return n;
}

function createdAtMs(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

export type BackfillResult = {
  sessions: number;
  bubbles: number;
  toolCalls: number;
  estimatedSessions: number;
  path: string;
};

export function backfillFromCursor(
  metricsDb: Database,
  statePath = cursorStateDbPath(),
): BackfillResult {
  const cursor = openCursorDb(statePath);
  let sessions = 0;
  let bubbles = 0;
  let toolCalls = 0;
  let estimatedSessions = 0;

  try {
    // Rebuild derived rows so re-runs don't duplicate tools
    metricsDb.exec(`
      DELETE FROM tool_calls;
      DELETE FROM turns;
      DELETE FROM token_snapshots;
      DELETE FROM session_rollups;
    `);

    const hasTable = cursor
      .query(`SELECT name FROM sqlite_master WHERE type='table' AND name='composerHeaders'`)
      .get() as { name: string } | null;

    const composers: Array<{
      composerId: string;
      workspaceId: string | null;
      createdAt: number | null;
      lastUpdatedAt: number | null;
      title: string | null;
      mode: string | null;
    }> = [];

    if (hasTable) {
      const rows = cursor
        .query(
          `SELECT composerId, workspaceId, createdAt, lastUpdatedAt, value FROM composerHeaders`,
        )
        .all() as Array<{
        composerId: string;
        workspaceId: string | null;
        createdAt: number | null;
        lastUpdatedAt: number | null;
        value: string;
      }>;
      for (const row of rows) {
        let parsed: ComposerHeader = {};
        try {
          parsed = JSON.parse(row.value) as ComposerHeader;
        } catch {
          /* ignore */
        }
        composers.push({
          composerId: row.composerId,
          workspaceId: row.workspaceId ?? workspaceFromHeader(parsed),
          createdAt: row.createdAt ?? parsed.createdAt ?? null,
          lastUpdatedAt: row.lastUpdatedAt ?? parsed.lastUpdatedAt ?? null,
          title: parsed.name ?? parsed.subtitle ?? null,
          mode: parsed.unifiedMode ?? null,
        });
      }
    }

    const txHeaders = metricsDb.transaction(() => {
      for (const c of composers) {
        upsertSession(metricsDb, {
          conversation_id: c.composerId,
          title: c.title,
          workspace: c.workspaceId,
          mode: c.mode,
          started_at: c.createdAt,
          ended_at: c.lastUpdatedAt,
          duration_ms:
            c.createdAt != null && c.lastUpdatedAt != null
              ? Math.max(0, c.lastUpdatedAt - c.createdAt)
              : null,
          source: "backfill",
        });
        sessions++;
      }
    });
    txHeaders();

    // Process bubbles per composer (avoids scanning 8GB blindly)
    const ids =
      composers.length > 0
        ? composers.map((c) => c.composerId)
        : (
            cursor
              .query(
                `SELECT DISTINCT substr(key, 10, 36) AS id FROM cursorDiskKV WHERE key LIKE 'bubbleId:%' LIMIT 5000`,
              )
              .all() as Array<{ id: string }>
          ).map((r) => r.id);

    for (const conversationId of ids) {
      const bubbleRows = cursor
        .query(
          `SELECT key, value FROM cursorDiskKV
           WHERE key LIKE ? AND length(value) < 2000000`,
        )
        .all(`bubbleId:${conversationId}:%`) as Array<{ key: string; value: unknown }>;

      if (!bubbleRows.length) continue;

      let sessionModel: string | null = null;
      let exactIn = 0;
      let exactOut = 0;
      let estIn = 0;
      let estOut = 0;
      let sawExact = false;
      const toolSeen = new Set<string>();

      const tx = metricsDb.transaction(() => {
        for (const row of bubbleRows) {
          const bubbleId = row.key.slice(`bubbleId:${conversationId}:`.length);
          let data: Bubble;
          try {
            data = JSON.parse(decodeValue(row.value)) as Bubble;
          } catch {
            continue;
          }

          const model = data.modelInfo?.modelName ?? null;
          if (model) sessionModel = sessionModel ?? model;
          const at = createdAtMs(data.createdAt);
          const tc = data.tokenCount ?? {};
          let input = Number(tc.inputTokens ?? 0);
          let output = Number(tc.outputTokens ?? 0);
          const cws = data.contextWindowStatusAtCreation?.tokensUsed;
          const contextTokens = typeof cws === "number" ? cws : null;
          let estimated = false;

          const think = thinkingChars(data.allThinkingBlocks);
          const textLen = (data.text ?? "").length;
          const toolChars = toolPayloadChars(data.toolFormerData);
          const isUser = data.type === 1 || data.type === "user";
          const isAssistant =
            data.type === 2 ||
            data.type === "ai" ||
            data.capabilityType != null ||
            data.toolFormerData != null;

          if (input === 0 && output === 0) {
            // Cursor often leaves tokenCount at 0 (gpt/composer/gemini/minimax).
            if (contextTokens != null && contextTokens > 0) {
              input = contextTokens;
              estimated = true;
            }
            if (isUser) {
              const u = charsToTokens(contentChars([data.text, data.richText]));
              if (u) {
                input = Math.max(input, u);
                estimated = true;
              }
            }
            if (isAssistant) {
              const o = charsToTokens(textLen + think);
              const toolTok = charsToTokens(toolChars);
              if (o) {
                output = o;
                estimated = true;
              }
              // Tool payloads mostly inflate later context (input), not assistant prose
              if (toolTok) {
                input += Math.floor(toolTok * 0.85);
                output += Math.floor(toolTok * 0.15);
                estimated = true;
              }
            }
          } else {
            sawExact = true;
          }

          if (input > 0 || output > 0 || contextTokens != null) {
            upsertTokenSnapshot(metricsDb, {
              conversation_id: conversationId,
              bubble_id: bubbleId,
              input_tokens: input,
              output_tokens: output,
              context_tokens: contextTokens,
              model,
              created_at: at,
              estimated,
            });
            bubbles++;
            if (estimated) {
              estIn += input;
              estOut += output;
            } else {
              exactIn += input;
              exactOut += output;
            }
          }

          // Real turns ≈ user messages (not every tool bubble)
          if (isUser) {
            const gen =
              (typeof data.requestId === "string" && data.requestId) ||
              bubbleId;
            upsertTurn(metricsDb, {
              conversation_id: conversationId,
              generation_id: gen,
              status: "user",
              ended_at: at,
            });
          }

          const tfName = data.toolFormerData?.name;
          if (tfName) {
            const dedupe = `${bubbleId}:${tfName}`;
            if (!toolSeen.has(dedupe)) {
              toolSeen.add(dedupe);
              insertToolCall(metricsDb, {
                conversation_id: conversationId,
                tool_name: tfName,
                success: data.toolFormerData?.status !== "error",
                created_at: at ?? Date.now(),
              });
              toolCalls++;
            }
          }
          if (Array.isArray(data.toolResults)) {
            for (const t of data.toolResults) {
              const name = t.toolName ?? t.name;
              if (!name) continue;
              const dedupe = `${bubbleId}:tr:${name}`;
              if (toolSeen.has(dedupe)) continue;
              toolSeen.add(dedupe);
              insertToolCall(metricsDb, {
                conversation_id: conversationId,
                tool_name: name,
                success: true,
                created_at: at ?? Date.now(),
              });
              toolCalls++;
            }
          }
        }

        upsertSession(metricsDb, {
          conversation_id: conversationId,
          model: sessionModel,
          source: "backfill",
        });
      });
      tx();

      if (!sawExact && estIn + estOut > 0) estimatedSessions++;
    }
  } finally {
    cursor.close();
  }

  recomputeAllRollups(metricsDb);
  return { sessions, bubbles, toolCalls, estimatedSessions, path: statePath };
}
