import type { Database } from "bun:sqlite";
import {
  insertToolCall,
  recomputeRollup,
  upsertSession,
  upsertTokenSnapshot,
  upsertTurn,
} from "../db/queries";
import { normalizeToolLabel } from "../shared/tools";
import { CLAUDE_CODE_PROFILE } from "./claude-code";
import type { HookPayload } from "../shared/types";

/**
 * Claude Code hook payload shape (settings.json hooks):
 *   {
 *     hook_event_name: "SessionStart" | "UserPromptSubmit" | "PostToolUse"
 *                    | "PostToolUseFailure" | "PreCompact" | "Stop" | ...,
 *     session_id, cwd, transcript_path,
 *     tool_name, tool_input, tool_response,
 *     message, prompt,
 *     hook_source: "claude-code"
 *   }
 *
 * We treat `conversation_id` aliases session_id and `workspace_roots` aliases [cwd].
 * Model is filled from `payload.model ?? payload.model_id` when present (Stop event).
 */

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function convId(p: HookPayload): string | null {
  return p.conversation_id ?? p.session_id ?? null;
}

function firstPrompt(p: HookPayload): string | null {
  const m = (p as { message?: unknown }).message;
  if (typeof m === "string") return m.replace(/\s+/g, " ").trim().slice(0, 240) || null;
  if (m && typeof m === "object") {
    const text = (m as { content?: unknown }).content;
    if (typeof text === "string") return text.replace(/\s+/g, " ").trim().slice(0, 240) || null;
  }
  const prompt = (p as { prompt?: unknown }).prompt;
  if (typeof prompt === "string") return prompt.replace(/\s+/g, " ").trim().slice(0, 240) || null;
  return null;
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

/** Sniff payload for Claude Code-specific fields. */
export function isClaudeCodePayload(p: HookPayload): boolean {
  if (typeof (p as { hook_source?: string }).hook_source === "string") {
    return (p as { hook_source: string }).hook_source.toLowerCase().includes("claude");
  }
  const ev = typeof p.hook_event_name === "string" ? p.hook_event_name : "";
  // Cursor uses camelCase; Claude Code uses PascalCase.
  return (
    ev === "SessionStart" ||
    ev === "UserPromptSubmit" ||
    ev === "PostToolUse" ||
    ev === "PostToolUseFailure" ||
    ev === "PreCompact" ||
    ev === "Stop"
  );
}

export function handleClaudeCodeHook(db: Database, payload: HookPayload): void {
  const event = payload.hook_event_name ?? "unknown";
  const id = convId(payload);
  const now = Date.now();
  const cwd = (payload as { cwd?: string }).cwd ?? null;

  if (!id) return;

  if (event === "SessionStart") {
    upsertSession(db, {
      conversation_id: id,
      workspace: cwd,
      workspace_path: cwd,
      model: payload.model_id ?? payload.model ?? null,
      started_at: now,
      source: "hook",
      profile: CLAUDE_CODE_PROFILE,
    });
    recomputeRollup(db, id);
    return;
  }

  // For everything else, ensure session exists
  upsertSession(db, {
    conversation_id: id,
    workspace: cwd,
    workspace_path: cwd,
    model: payload.model_id ?? payload.model ?? null,
    source: "hook",
    profile: CLAUDE_CODE_PROFILE,
  });

  switch (event) {
    case "UserPromptSubmit": {
      const gen = `prompt-${now}`;
      const prompt = firstPrompt(payload);
      upsertTurn(db, {
        conversation_id: id,
        generation_id: gen,
        status: "user",
        ended_at: now,
      });
      // Surface first user prompt even from the live hook so the dashboard
      // doesn't wait on a backfill for the title.
      if (prompt) {
        db.run(`UPDATE sessions SET first_prompt = COALESCE(first_prompt, ?) WHERE conversation_id = ?`, [
          prompt,
          id,
        ]);
      }
      break;
    }
    case "PostToolUse": {
      insertToolCall(db, {
        conversation_id: id,
        tool_name: toolLabel(payload),
        success: true,
        created_at: now,
      });
      break;
    }
    case "PostToolUseFailure": {
      insertToolCall(db, {
        conversation_id: id,
        tool_name: toolLabel(payload),
        success: false,
        created_at: now,
      });
      break;
    }
    case "PreCompact": {
      // No context_events yet for Claude Code metrics; record into session.
      db.run(
        `UPDATE sessions SET ended_at = COALESCE(ended_at, ?) WHERE conversation_id = ?`,
        [now, id],
      );
      break;
    }
    case "Stop": {
      const gen = `stop-${now}`;
      upsertTurn(db, {
        conversation_id: id,
        generation_id: gen,
        status: payload.status ?? "completed",
        ended_at: now,
      });
      // Claude Code's Stop event has rich usage on the `usage` field if exposed.
      const usage = (payload as { usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } }).usage;
      if (usage) {
        const input = num(usage.input_tokens);
        const output = num(usage.output_tokens);
        const cr = num(usage.cache_read_input_tokens);
        const cw = num(usage.cache_creation_input_tokens);
        if (input || output || cr || cw) {
          upsertTokenSnapshot(db, {
            conversation_id: id,
            bubble_id: `cc-hook:${gen}`,
            input_tokens: input,
            output_tokens: output,
            cache_read_tokens: cr,
            cache_write_tokens: cw,
            model: payload.model_id ?? payload.model ?? null,
            created_at: now,
            estimated: false,
          });
        }
      }
      db.run(`UPDATE sessions SET ended_at = COALESCE(ended_at, ?) WHERE conversation_id = ?`, [
        now,
        id,
      ]);
      break;
    }
    default:
      break;
  }

  recomputeRollup(db, id);
}
