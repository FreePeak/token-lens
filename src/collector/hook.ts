import type { Database } from "bun:sqlite";
import {
  insertContextEvent,
  insertToolCall,
  recomputeRollup,
  upsertSession,
  upsertTurn,
} from "../db/queries";
import { normalizeToolLabel } from "../shared/tools";
import type { HookPayload } from "../shared/types";

function convId(p: HookPayload): string | null {
  return p.conversation_id ?? p.session_id ?? null;
}

function workspace(p: HookPayload): string | null {
  const roots = p.workspace_roots;
  if (!roots?.length) return null;
  return roots[0] ?? null;
}

function toolName(p: HookPayload): string {
  let name = "unknown";
  if (typeof p.tool_name === "string" && p.tool_name) name = p.tool_name;
  else {
    const nested = (p as { tool?: { name?: string } }).tool?.name;
    if (nested) name = nested;
  }
  const input = p.tool_input;
  const params =
    typeof input === "string"
      ? input
      : input != null
        ? JSON.stringify(input)
        : null;
  return normalizeToolLabel(name, { params });
}

export function handleHook(db: Database, payload: HookPayload): void {
  const event = payload.hook_event_name ?? "unknown";
  const id = convId(payload);
  const now = Date.now();

  // sessionStart may only have session_id
  if (event === "sessionStart" && id) {
    upsertSession(db, {
      conversation_id: id,
      workspace: workspace(payload),
      model: payload.model_id ?? payload.model ?? null,
      mode: payload.composer_mode ?? null,
      started_at: now,
      source: "hook",
    });
    recomputeRollup(db, id);
    return;
  }

  if (!id) return;

  upsertSession(db, {
    conversation_id: id,
    workspace: workspace(payload),
    model: payload.model_id ?? payload.model ?? null,
    mode: payload.composer_mode ?? null,
    source: "hook",
  });

  switch (event) {
    case "sessionEnd": {
      upsertSession(db, {
        conversation_id: id,
        ended_at: now,
        duration_ms: typeof payload.duration_ms === "number" ? payload.duration_ms : null,
        source: "hook",
      });
      break;
    }
    case "stop": {
      const gen = payload.generation_id ?? `stop-${now}`;
      upsertTurn(db, {
        conversation_id: id,
        generation_id: gen,
        status: payload.status ?? "completed",
        ended_at: now,
      });
      break;
    }
    case "postToolUse": {
      insertToolCall(db, {
        conversation_id: id,
        generation_id: payload.generation_id ?? null,
        tool_name: toolName(payload),
        duration_ms: typeof payload.duration_ms === "number" ? payload.duration_ms : null,
        success: true,
        created_at: now,
      });
      break;
    }
    case "postToolUseFailure": {
      insertToolCall(db, {
        conversation_id: id,
        generation_id: payload.generation_id ?? null,
        tool_name: toolName(payload),
        duration_ms: typeof payload.duration_ms === "number" ? payload.duration_ms : null,
        success: false,
        created_at: now,
      });
      break;
    }
    case "preCompact": {
      insertContextEvent(db, {
        conversation_id: id,
        context_tokens: payload.context_tokens ?? null,
        context_usage_percent: payload.context_usage_percent ?? null,
        context_window_size: payload.context_window_size ?? null,
        created_at: now,
      });
      break;
    }
    case "afterAgentResponse": {
      // Ensure a turn exists for this generation even if stop hasn't fired yet
      if (payload.generation_id) {
        upsertTurn(db, {
          conversation_id: id,
          generation_id: payload.generation_id,
          status: "responded",
          ended_at: now,
        });
      }
      break;
    }
    default:
      break;
  }

  recomputeRollup(db, id);
}
