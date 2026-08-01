import { backfillOpenCode } from "../collector/opencode";
import { installOpenCodeHooks } from "../collector/install-hooks-opencode";
import type { Tool } from "./types";

export const openCodeTool: Tool = {
  id: "opencode",
  displayName: "OpenCode",
  statePathHints: [".config/opencode", ".local/share/opencode"],
  async backfill(metricsDb, opts) {
    const r = await backfillOpenCode(metricsDb, { resume: opts.resume });
    return { changed: r.sessions, bubbles: 0, toolCalls: r.toolCalls };
  },
  installHooks: installOpenCodeHooks,
};
