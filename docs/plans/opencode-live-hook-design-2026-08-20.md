# Design: OpenCode Live Hook Plugin for token-lens

**Date:** 2026-08-20
**Status:** Planned → Implementing (P1 gap)
**Related:** gap-analysis-2026-08-20.md, audit-2026-08-20.md

## Goal
Bring OpenCode live capture to parity with Cursor (`hooks.json`) and Claude Code (`settings.json`) by installing a real OpenCode plugin that streams events into `~/.token-lens/metrics.db` via the existing `hook --tool opencode` CLI.

## Current state
- `src/collector/install-hooks-opencode.ts` returns empty strings and logs “live hooks are not yet supported”.
- `src/collector/hook-opencode.ts` handles 4 speculative events (`sessionStart`, `sessionEnd`, `postToolUse`, `afterAgentResponse`) dispatched via `src/collector/hook.ts`.
- OpenCode plugin API is stable (`@opencode-ai/plugin@1.18.16`), events used by `auto-retry` plugin prove it.

## Non-goals
- Polling backfill already covers near-real-time (15m interval in `serve`). Plugin is for immediate (<1s) dashboard freshness, not correctness.
- No cloud, no telemetry.

## Architecture

```
opencode process  ──plugin event──▶  token-lens plugin (~/.config/opencode/plugins/token-lens.ts)
                                          │
                                          │ spawn  bun <token-lens>/src/cli.ts hook --tool opencode
                                          │         stdin: {hook_source:"opencode", hook_event_name, session_id, ...}
                                          ▼
                                  token-lens hook dispatcher (src/collector/hook.ts)
                                          │
                                          ▼
                                  metrics.db  ──▶  Bun API  ──▶  React dashboard
```

### Why spawn CLI vs direct DB write?
- Isolation: plugin runs inside opencode's Bun sandbox; direct `bun:sqlite` write would couple to metrics.db WAL and could contend.
- Reuse: keeps `hook-opencode.ts` as single ingestion path; no duplicate logic.
- Fallback: if `bun` not in PATH, plugin falls back to `node --import tsx` or no-op (echo `{"continue":true}`).

## Plugin file location & discovery
- Opencode resolves plugins from:
  1. `opencode.json: { "plugin": ["@scope/pkg", "file://<abs-path>", "./local/plugin.ts"] }`
  2. `~/.config/opencode/plugins/*.ts` auto-scanned? No — explicit entry required (verified: existing `leankg@git+...` is explicit).
  3. Project-local `.opencode/plugins/` (per-project).
- Decision: Installer writes to `~/.config/opencode/plugins/token-lens.ts` and patches `~/.config/opencode/opencode.json` to include `"token-lens"`-like entry. Use relative path if opencode supports `plugin: ["./plugins/token-lens.ts"]` with `~/.config/opencode` as base, else absolute `file://` URL.
- Check existing opencode.json: `cat ~/.config/opencode/opencode.json` shows `"plugin": ["leankg@git+..."]`. So we append our plugin string and deduplicate.

## Event mapping

OpenCode events → token-lens `HookPayload.hook_event_name`

| OpenCode event | Properties | token-lens event | Payload fields |
|----------------|------------|------------------|----------------|
| `session.created` | `{sessionID, title, directory, projectID, ...}` | `sessionStart` | `session_id`, `workspace_path=directory`, `model?` |
| `session.updated` | `{sessionID, title}` | (update title) | `session_id`, title→ upsertSession title |
| `message.updated` | `{message:{id, role, content, modelID?}, parts: [{type}]}` | `afterAgentResponse` (assistant) or user turn | `session_id`, `generation_id=message.id`, `model_id`, `input_tokens/output_tokens/cache_*` if usage present, `text` |
| `part.updated` / `part.created` | `{part:{type:"tool", tool, state:{input, status, output}}}` | `postToolUse` | `session_id`, `tool_name`, `tool_input`, `generation_id=part.messageID` |
| `session.idle` | `{sessionID}` | `sessionEnd` (implicit) | `session_id`, `duration_ms?` |
| `session.status` with `type:"idle"` | same | `sessionEnd` | |
| `session.deleted` / `session.error` | | (ignore or log) | |

### Token extraction for `message.updated`
- Message JSON shape in opencode DB: `{role, modelID, providerID, tokens:{input, output, cache:{read,write}}, content}` but SDK `message.updated` may deliver `info.tokens` or `parts` with `type:"tool"` etc.
- First inspect SDK Event type: from `@opencode-ai/sdk` `Event` union. Use `(event.properties as any).info` like auto-retry does (`info.sessionID`, `info.error`). For `message.updated`, `info` is message info with `info.tokens`? Need to test via logging.
- Fallback: query `opencode.db` for latest `tokens_input` etc. if not in event (same as auto-retry's `getLastUserMessageFromDb` pattern). Simpler: let backfill reconcile; plugin only sends what event carries, backfill will fill missing tokens on next 15m cycle.

## Installer spec (`installOpenCodeHooks(projectRoot)`)
```ts
export function installOpenCodeHooks(projectRoot: string): { hooksJson: string; script: string } {
  const opencodeConfigDir = join(homedir(), ".config", "opencode");
  const pluginDir = join(opencodeConfigDir, "plugins");
  const pluginPath = join(pluginDir, "token-lens.ts");
  const opencodeJson = join(opencodeConfigDir, "opencode.json");
  // 1. mkdir -p pluginDir
  // 2. writeFile pluginPath with template (see below)
  // 3. read opencodeJson, ensure json.plugin is array, deduplicate, push `file://${pluginPath}` or `./plugins/token-lens.ts`
  // 4. writeFile opencodeJson
  // 5. return { hooksJson: opencodeJson, script: pluginPath }
}
```
- Must be idempotent: re-running installer does not duplicate plugin entry, overwrites plugin file with latest template.
- Template embeds `ROOT` constant = `resolve(projectRoot)` so spawn path is absolute.

## Plugin template (`token-lens.ts`)

```ts
import type { Plugin } from "@opencode-ai/plugin";
import { spawn } from "node:child_process";
import { resolve, join } from "node:path";
import { homedir } from "node:os";

const TOKEN_LENS_ROOT = "<ROOT_PLACEHOLDER>"; // replaced by installer
const HOOK_CMD = ["bun", join(TOKEN_LENS_ROOT, "src/cli.ts"), "hook", "--tool", "opencode"];

function fire(payload: Record<string, unknown>) {
  try {
    const child = spawn(HOOK_CMD[0]!, HOOK_CMD.slice(1), { stdio: ["pipe", "ignore", "ignore"], detached: false });
    child.stdin.write(JSON.stringify({ hook_source: "opencode", ...payload }));
    child.stdin.end();
    child.on("error", () => {});
  } catch {}
}

export const TokenLensPlugin: Plugin = async () => ({
  event: async ({ event }) => {
    const p: any = event.properties;
    switch (event.type) {
      case "session.created": {
        const sid = p.sessionID ?? p.sessionId ?? p.id;
        if (!sid) return;
        fire({ hook_event_name: "sessionStart", session_id: sid, workspace_path: p.directory ?? p.workdir ?? null, model_id: p.modelID ?? p.model ?? null });
        break;
      }
      case "part.updated":
      case "part.created": {
        const part = p.part ?? p.info ?? p;
        if (part?.type !== "tool" || !part.tool) return;
        const sid = p.sessionID ?? part.sessionID ?? part.session_id;
        if (!sid) return;
        fire({ hook_event_name: "postToolUse", session_id: sid, tool_name: part.tool, tool_input: part.state?.input ?? part.input, generation_id: part.messageID ?? part.message_id });
        break;
      }
      case "message.updated": {
        const info = p.info ?? p.message ?? p;
        if (!info || info.role !== "assistant") return;
        const tokens = info.tokens ?? info.usage ?? {};
        const sid = info.sessionID ?? p.sessionID;
        if (!sid) return;
        fire({
          hook_event_name: "afterAgentResponse",
          session_id: sid,
          generation_id: info.id ?? info.messageID,
          model_id: info.modelID ?? info.model ?? null,
          input_tokens: tokens.input ?? tokens.input_tokens ?? 0,
          output_tokens: tokens.output ?? tokens.output_tokens ?? 0,
          cache_read_tokens: tokens.cache?.read ?? tokens.cache_read_input_tokens ?? 0,
          cache_write_tokens: tokens.cache?.write ?? tokens.cache_creation_input_tokens ?? 0,
        });
        break;
      }
      case "session.idle": {
        const sid = p.sessionID ?? p.sessionId;
        if (!sid) return;
        fire({ hook_event_name: "sessionEnd", session_id: sid });
        break;
      }
      case "session.status": {
        if (p.status?.type === "idle") {
          const sid = p.sessionID ?? p.sessionId;
          if (sid) fire({ hook_event_name: "sessionEnd", session_id: sid });
        }
        break;
      }
    }
  },
});
export default { id: "token-lens", server: TokenLensPlugin };
```

- Keep plugin <150 lines, no external deps beyond `node:child_process`.
- `chmod` not needed (plugin is imported, not executed as shell).
- Log via `client.app.log` if available (like auto-retry).

## Hook handler changes (`hook-opencode.ts`)
- Keep existing 4 events; add `isOpenCodePayload` already ok.
- Add handling for `session.updated`? Currently `upsertSession` at top of `handleOpenCodeHook` already does generic upsert for any event with `session_id`, so title updates flow.
- No change needed except ensure `toolLabel` normalizes correctly (already uses `normalizeToolLabel`).

## Edge cases
- Opencode running without `bun` on PATH: fallback to `node --import tsx` chain as Claude hook does.
- Duplicate events: `part.updated` fires multiple times per tool (status pending→completed). Deduplicate via `(sessionID, partID)`? Easiest: let `handleOpenCodeHook` insertToolCall with `generation_id` = `partID`; if same part fires twice, second insert creates duplicate tool_call. Mitigate by using `INSERT OR IGNORE` if we add unique constraint, or plugin checks `state.status === "completed"` only. Add guard: only fire `postToolUse` when `state.status === "completed"` or `state.status === "error"`.
- Performance: spawn per event (~1-50 per session) is fine; opencode already spawns per tool anyway.

## Testing plan
- `tests/collector-opencode.test.ts` already covers backfill.
- New `tests/hook-opencode.test.ts`: synthetic payloads for each of the 4 events + `isOpenCodePayload`, verify DB rows.
- Manual: `bun run install-hooks --tool opencode && cat ~/.config/opencode/opencode.json` should show new plugin; `echo '{"hook_source":"opencode","hook_event_name":"sessionStart","session_id":"manual-test-123"}' | bun src/cli.ts hook --tool opencode && sqlite3 ~/.token-lens/metrics.db "SELECT * FROM sessions WHERE conversation_id='manual-test-123'"` should return row and cleanup.

## Rollback
- Installer should backup `opencode.json` to `opencode.json.bak` before patch.

## Docs update
- README: change OpenCode row from `🟡 Use backfill` to `✅ (plugin)` after installer lands.
- CLI usage unchanged.

## Verification for step 4 (this design doc)
- File exists at `docs/plans/opencode-live-hook-design-2026-08-20.md` ✅
- Covers event mapping, installer spec, template, edge cases, testing.
