import { homedir } from "os";
import { join } from "path";

/**
 * OpenCode does not (yet) expose a stable local live-hooks API for
 * incremental event capture — it logs to its `opencode.db` on shutdown.
 * Until a plugin protocol is finalized, this installer prints guidance
 * pointing users at `bun run backfill --tool opencode`.
 */
export function installOpenCodeHooks(
  _projectRoot: string,
): { hooksJson: string; script: string } {
  const home = homedir();
  // Print, but don't fail — the script returns the directory we'd write into.
  console.log(
    `[token-lens] OpenCode: live hooks are not yet supported.\n` +
      `  Sessions aggregate tokens/cost into ${join(home, ".local", "share", "opencode", "opencode.db")}\n` +
      `  Run:  bun run backfill --tool opencode`,
  );
  return {
    hooksJson: "",
    script: "",
  };
}
