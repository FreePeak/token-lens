import type { Tool } from "./types";

export const openCodeTool: Tool = {
  id: "opencode",
  displayName: "OpenCode",
  statePathHints: [".config/opencode", ".local/share/opencode"],
  async backfill() {
    // ponytail: stub for future support. Add an OpenCode message-log parser
    // mirroring collector/backfill.ts when implementing.
    throw new Error("token-lens: OpenCode backfill is not implemented yet (Cursor is the first supported tool).");
  },
};
