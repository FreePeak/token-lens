import type { Tool } from "./types";

export const claudeCodeTool: Tool = {
  id: "claude-code",
  displayName: "Claude Code",
  statePathHints: [".claude"],
  async backfill() {
    // ponytail: stub for future support. Claude Code stores sessions as JSONL
    // under ~/.claude/projects/<workspace>/<session>.jsonl. Add a JSONL parser
    // mirroring collector/backfill.ts when implementing.
    throw new Error("token-lens: Claude Code backfill is not implemented yet (Cursor is the first supported tool).");
  },
};
