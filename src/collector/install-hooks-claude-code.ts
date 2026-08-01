import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";

const HOOKS_DIR = join(homedir(), ".claude", "hooks");
const SETTINGS_JSON = join(homedir(), ".claude", "settings.json");

// Claude Code settings.json hooks schema. Each event maps to an array of
// matcher objects with a `hooks` array of `{type:"command",command}` entries.
const EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PostToolUse",
  "PostToolUseFailure",
  "PreCompact",
  "Stop",
] as const;

export function installClaudeCodeHooks(projectRoot: string): { hooksJson: string; script: string } {
  mkdirSync(HOOKS_DIR, { recursive: true });
  const root = resolve(projectRoot);
  const scriptPath = join(HOOKS_DIR, "token-lens-hook.sh");
  const script = `#!/usr/bin/env bash
# token-lens hook for Claude Code — reads JSON stdin, writes to metrics DB
# Adds the tool id so the CLI can route to the Claude Code handler.
set -euo pipefail
ROOT="${root}"
TOOL="claude-code"
if command -v bun >/dev/null 2>&1; then
  exec bun "$ROOT/src/cli.ts" hook --tool "$TOOL"
elif command -v npx >/dev/null 2>&1; then
  exec npx -y tsx "$ROOT/src/cli.ts" hook --tool "$TOOL"
elif command -v node >/dev/null 2>&1; then
  exec node --import tsx "$ROOT/src/cli.ts" hook --tool "$TOOL" 2>/dev/null || exec bun "$ROOT/src/cli.ts" hook --tool "$TOOL"
else
  echo '{"continue":true}'
  exit 0
fi
`;
  writeFileSync(scriptPath, script, "utf8");
  chmodSync(scriptPath, 0o755);

  const command = scriptPath;

  let existing: Record<string, unknown> = {};
  if (existsSync(SETTINGS_JSON)) {
    try {
      existing = JSON.parse(readFileSync(SETTINGS_JSON, "utf8")) as Record<string, unknown>;
    } catch {
      writeFileSync(`${SETTINGS_JSON}.bak`, readFileSync(SETTINGS_JSON));
      existing = {};
    }
  }

  const hooksRoot =
    existing.hooks && typeof existing.hooks === "object" && !Array.isArray(existing.hooks)
      ? (existing.hooks as Record<string, unknown>)
      : {};
  existing.hooks = hooksRoot;

  for (const ev of EVENTS) {
    const list = Array.isArray(hooksRoot[ev]) ? [...hooksRoot[ev]!] : [];
    // Drop legacy entries (token-lens-hook with or without --tool flag)
    const dedup = list.filter(
      (h) =>
        !(
          h &&
          typeof h === "object" &&
          "hooks" in (h as Record<string, unknown>) &&
          Array.isArray((h as { hooks: unknown }).hooks) &&
          ((h as { hooks: Array<{ command?: string }> }).hooks).some(
            (entry) =>
              entry && typeof entry === "object" &&
              typeof (entry as { command?: string }).command === "string" &&
              ((entry as { command: string }).command).includes("token-lens-hook"),
          )
        ),
    );
    dedup.push({ hooks: [{ type: "command", command }] });
    hooksRoot[ev] = dedup;
  }

  mkdirSync(dirname(SETTINGS_JSON), { recursive: true });
  writeFileSync(SETTINGS_JSON, JSON.stringify(existing, null, 2) + "\n", "utf8");
  return { hooksJson: SETTINGS_JSON, script: scriptPath };
}
