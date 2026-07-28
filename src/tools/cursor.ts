import { backfillIncrementalAll, backfillAllProfiles } from "../collector/backfill";
import { installHooks } from "../collector/install-hooks";
import { syncUsageProfiles } from "../collector/sync-usage";
import type { Tool } from "./types";

export const cursorTool: Tool = {
  id: "cursor",
  displayName: "Cursor",
  statePathHints: [
    "Library/Application Support/Cursor",
    "Library/Application Support/Cur",
    ".cursor",
    ".cur",
  ],
  async backfill(metricsDb, opts) {
    const r = opts.resume ? await backfillIncrementalAll(metricsDb) : await backfillAllProfiles(metricsDb);
    return { changed: r.changed, bubbles: r.bubbles, toolCalls: r.toolCalls };
  },
  installHooks: installHooks,
  supportsUsageSync: true,
  async syncUsage(metricsDb, opts) {
    return syncUsageProfiles(metricsDb, { days: opts.days ?? 7, profile: opts.profile ?? "all" });
  },
};
