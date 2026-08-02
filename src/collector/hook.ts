import type { Database } from "bun:sqlite";
import type { HookPayload } from "../shared/types";
import {
  handleClaudeCodeHook,
  isClaudeCodePayload,
} from "./hook-claude-code";
import {
  handleCursorHook,
} from "./hook-cursor";
import {
  handleOpenCodeHook,
  isOpenCodePayload,
} from "./hook-opencode";

export { handleCursorHook } from "./hook-cursor";
export { handleClaudeCodeHook, isClaudeCodePayload } from "./hook-claude-code";
export { handleOpenCodeHook, isOpenCodePayload } from "./hook-opencode";

/**
 * Top-level dispatcher. The CLI invokes this with an optional `--tool <id>`
 * hint; if absent, the payload is sniffed to pick the right handler.
 *
 * Cursor is the default (preserves the bundled `~/.cursor/hooks/token-lens-hook.sh`).
 */
export function handleHook(db: Database, payload: HookPayload, tool?: string): void {
  if (tool === "claude-code") return handleClaudeCodeHook(db, payload);
  if (tool === "opencode") return handleOpenCodeHook(db, payload);
  if (tool === "cursor") return handleCursorHook(db, payload);

  if (isClaudeCodePayload(payload)) return handleClaudeCodeHook(db, payload);
  if (isOpenCodePayload(payload)) return handleOpenCodeHook(db, payload);
  // Default to Cursor for backward compat.
  handleCursorHook(db, payload);
}

// Re-export the payload type for legacy imports.
export type { HookPayload };
