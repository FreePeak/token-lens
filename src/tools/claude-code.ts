import { backfillClaudeCode } from "../collector/claude-code";
import { installClaudeCodeHooks } from "../collector/install-hooks-claude-code";
import type { Tool } from "./types";

export const claudeCodeTool: Tool = {
  id: "claude-code",
  displayName: "Claude Code",
  statePathHints: [".claude"],
  async backfill(metricsDb, opts) {
    return backfillClaudeCode(metricsDb, { resume: opts.resume });
  },
  installHooks: installClaudeCodeHooks,
};
