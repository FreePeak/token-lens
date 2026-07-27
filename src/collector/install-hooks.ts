import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";

const HOOKS_DIR = join(homedir(), ".cursor", "hooks");
const HOOKS_JSON = join(homedir(), ".cursor", "hooks.json");

const EVENTS = [
  "sessionStart",
  "sessionEnd",
  "stop",
  "postToolUse",
  "postToolUseFailure",
  "preCompact",
  "afterAgentResponse",
] as const;

export function installHooks(projectRoot: string): { hooksJson: string; script: string } {
  mkdirSync(HOOKS_DIR, { recursive: true });
  const root = resolve(projectRoot);
  const scriptPath = join(HOOKS_DIR, "cursor-metrics-hook.sh");
  const script = `#!/usr/bin/env bash
# cursor-metrics hook — reads JSON stdin, appends to metrics DB
set -euo pipefail
ROOT="${root}"
if command -v bun >/dev/null 2>&1; then
  exec bun "$ROOT/src/cli.ts" hook
elif command -v node >/dev/null 2>&1; then
  exec node --import tsx "$ROOT/src/cli.ts" hook 2>/dev/null || exec bun "$ROOT/src/cli.ts" hook
else
  echo '{"continue":true}' 
  exit 0
fi
`;
  writeFileSync(scriptPath, script, "utf8");
  chmodSync(scriptPath, 0o755);

  const command = scriptPath;
  const entry = [{ command }];

  let existing: { version?: number; hooks?: Record<string, unknown[]> } = {
    version: 1,
    hooks: {},
  };
  if (existsSync(HOOKS_JSON)) {
    try {
      existing = JSON.parse(readFileSync(HOOKS_JSON, "utf8")) as typeof existing;
    } catch {
      /* start fresh but backup-ish */
      writeFileSync(`${HOOKS_JSON}.bak`, readFileSync(HOOKS_JSON));
    }
  }
  existing.version = existing.version ?? 1;
  existing.hooks = existing.hooks ?? {};

  for (const ev of EVENTS) {
    const list = Array.isArray(existing.hooks[ev]) ? [...existing.hooks[ev]!] : [];
    const already = list.some(
      (h) =>
        typeof h === "object" &&
        h != null &&
        "command" in h &&
        String((h as { command: string }).command).includes("cursor-metrics-hook"),
    );
    if (!already) list.push({ command });
    existing.hooks[ev] = list;
  }

  mkdirSync(dirname(HOOKS_JSON), { recursive: true });
  writeFileSync(HOOKS_JSON, JSON.stringify(existing, null, 2) + "\n");
  return { hooksJson: HOOKS_JSON, script: scriptPath };
}
