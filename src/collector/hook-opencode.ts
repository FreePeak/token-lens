import type { Database } from "bun:sqlite";
import {
  insertToolCall,
  recomputeRollup,
  upsertSession,
  upsertTokenSnapshot,
  upsertTurn,
} from "../db/queries";
import { normalizeToolLabel } from "../shared/tools";
import { OPENCODE_PROFILE } from "./opencode";
import type { HookPayload } from "../shared/types";

/**
 * OpenCode live-hook shape is speculative (the plugin API is still
 * stabilizing). We accept the same `hook_event_name` envelope as the
 * Cursor / Claude Code payloads and route into the metrics DB.
 *
 * Useful events we anticipate:
 *   - "sessionStart"  /  "sessionEnd"
 *   - "postToolUse"
 *   - "afterAgentResponse"
 */

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function convId(p: HookPayload): string | null {
  return p.conversation_id ?? p.session_id ?? null;
}

function toolLabel(p: HookPayload): string {
  let name = "unknown";
  if (typeof p.tool_name === "string" && p.tool_name) name = p.tool_name;
  const input = p.tool_input;
  const params =
    typeof input === "string"
      ? input
      : input != null
        ? JSON.stringify(input)
        : null;
  return normalizeToolLabel(name, { params });
}

export function isOpenCodePayload(p: HookPayload): boolean {
  return (p as { hook_source?: string }).hook_source === "opencode";
}

export function handleOpenCodeHook(db: Database, payload: HookPayload): void {
  const event = payload.hook_event_name ?? "unknown";
  const id = convId(payload);
  const now = Date.now();
  const wsRoot = (payload as { workspace_path?: string }).workspace_path ?? null;

  if (!id) return;

  if (event === "sessionStart") {
    upsertSession(db, {
      conversation_id: id,
      workspace: wsRoot,
      workspace_path: wsRoot,
      model: payload.model_id ?? payload.model ?? null,
      started_at: now,
      source: "hook",
      profile: OPENCODE_PROFILE,
    });
    recomputeRollup(db, id);
    return;
  }

  upsertSession(db, {
    conversation_id: id,
    workspace: wsRoot,
    workspace_path: wsRoot,
    model: payload.model_id ?? payload.model ?? null,
    source: "hook",
    profile: OPENCODE_PROFILE,
  });

  switch (event) {
    case "sessionEnd":
      upsertSession(db, {
        conversation_id: id,
        ended_at: now,
        duration_ms: typeof payload.duration_ms === "number" ? payload.duration_ms : null,
        source: "hook",
        profile: OPENCODE_PROFILE,
      });
      break;
    case "postToolUse":
      insertToolCall(db, {
        conversation_id: id,
        tool_name: toolLabel(payload),
        success: true,
        created_at: now,
      });
      break;
    case "afterAgentResponse": {
      const gen = payload.generation_id ?? `aar-${now}`;
      upsertTurn(db, {
        conversation_id: id,
        generation_id: gen,
        status: "responded",
        ended_at: now,
      });
      const input = num(payload.input_tokens);
      const output = num(payload.output_tokens);
      const cacheRead = num(payload.cache_read_tokens);
      const cacheWrite = num(payload.cache_write_tokens);
      if (input || output || cacheRead || cacheWrite) {
        upsertTokenSnapshot(db, {
          conversation_id: id,
          bubble_id: `oc-hook:${gen}`,
          input_tokens: input,
          output_tokens: output,
          cache_read_tokens: cacheRead,
          cache_write_tokens: cacheWrite,
          model: payload.model_id ?? payload.model ?? null,
          created_at: now,
          estimated: false,
        });
      }
      break;
    }
    default:
      break;
  }

  recomputeRollup(db, id);
}
