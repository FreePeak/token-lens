import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";

const OPENCODE_CONFIG_DIR = join(homedir(), ".config", "opencode");
const OPENCODE_JSON = join(OPENCODE_CONFIG_DIR, "opencode.json");
const PLUGIN_DIR = join(OPENCODE_CONFIG_DIR, "plugins");
const PLUGIN_PATH = join(PLUGIN_DIR, "token-lens.ts");

function pluginTemplate(tokenLensRoot: string): string {
  // Keep template small, no external deps beyond node:child_process and @opencode-ai/plugin types
  const root = tokenLensRoot.replace(/"/g, '\\"');
  return `import type { Plugin } from "@opencode-ai/plugin";
import { spawn } from "node:child_process";
import { join } from "node:path";

const TOKEN_LENS_ROOT = "${root}";
const HOOK_BASE = [join(TOKEN_LENS_ROOT, "src/cli.ts"), "hook", "--tool", "opencode"] as const;

function fire(payload: Record<string, unknown>): void {
  const body = JSON.stringify({ hook_source: "opencode", ...payload });
  // Try bun first, fallback to node+tsx, then npx
  const trySpawn = (cmd: string, args: string[]) => {
    try {
      const child = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] });
      child.stdin.write(body);
      child.stdin.end();
      child.on("error", () => {});
      return true;
    } catch { return false; }
  };
  // Prefer bun
  if (trySpawn("bun", [...HOOK_BASE])) return;
  // Fallback: node --import tsx
  if (trySpawn("node", ["--import", "tsx", ...HOOK_BASE])) return;
  // Last resort: npx
  trySpawn("npx", ["-y", "tsx", ...HOOK_BASE]);
}

export const TokenLensPlugin: Plugin = async ({ client }) => {
  const log = async (level: "info" | "debug" | "warn" | "error", msg: string, extra?: Record<string, unknown>) => {
    try {
      const anyClient = client as unknown as { app?: { log?: (args: unknown) => Promise<void> } };
      if (anyClient?.app?.log) await anyClient.app.log({ body: { service: "token-lens", level, message: msg, extra } } as never);
      else console.log(\`[token-lens:\${level}] \${msg}\`, extra ?? "");
    } catch {}
  };
  await log("info", "token-lens plugin active", { root: TOKEN_LENS_ROOT });

  return {
    event: async ({ event }) => {
      const p = (event.properties ?? {}) as Record<string, unknown>;
      const type = (event as { type?: string }).type ?? (p.type as string) ?? "";

      // session lifecycle — created maps to sessionStart
      if (type === "session.created" || type === "session_created") {
        const sid = (p.sessionID as string) ?? (p.sessionId as string) ?? (p.id as string);
        if (!sid) return;
        fire({ hook_event_name: "sessionStart", session_id: sid, workspace_path: (p.directory as string) ?? (p.workdir as string) ?? null, model_id: (p.model as string) ?? (p.modelID as string) ?? null });
        return;
      }
      if (type === "session.deleted" || type === "session_deleted") {
        const sid = (p.sessionID as string) ?? (p.sessionId as string) ?? (p.id as string);
        if (!sid) return;
        fire({ hook_event_name: "sessionEnd", session_id: sid });
        return;
      }
      if (type === "session.idle" || type === "session_idle") {
        const sid = (p.sessionID as string) ?? (p.sessionId as string) ?? (p.id as string);
        if (sid) fire({ hook_event_name: "sessionEnd", session_id: sid });
        return;
      }
      if (type === "session.status") {
        const status = p.status as { type?: string } | undefined;
        const sid = (p.sessionID as string) ?? (p.sessionId as string);
        if (status?.type === "idle" && sid) fire({ hook_event_name: "sessionEnd", session_id: sid });
        return;
      }
      if (type === "session.updated" || type === "session_updated") {
        // Keep session title/model fresh — generic upsert path
        const sid = (p.sessionID as string) ?? (p.sessionId as string) ?? (p.id as string);
        if (sid) fire({ hook_event_name: "sessionStart", session_id: sid, workspace_path: (p.directory as string) ?? null, model_id: (p.model as string) ?? null });
        return;
      }

      // part events — tool calls. Only forward completed/error to avoid dup pending states
      if (type === "part.updated" || type === "part.created" || type === "part_updated" || type === "part_created") {
        const part = (p.part as Record<string, unknown>) ?? (p.info as Record<string, unknown>) ?? p;
        if ((part.type as string) !== "tool") return;
        const tool = part.tool as string | undefined;
        if (!tool) return;
        const state = (part.state as { status?: string; input?: unknown } | undefined);
        // Deduplicate: only forward when tool finishes (completed/error) — opencode fires pending → completed
        if (state?.status && !/completed|error|fail/i.test(state.status)) return;
        const sid = (part.sessionID as string) ?? (part.session_id as string) ?? (p.sessionID as string);
        if (!sid) return;
        fire({ hook_event_name: "postToolUse", session_id: sid, tool_name: tool, tool_input: state?.input ?? null, generation_id: (part.messageID as string) ?? (part.message_id as string) ?? undefined });
        return;
      }

      // message events — token usage snapshots. Only assistant messages with tokens matter
      if (type === "message.updated" || type === "message_updated" || type === "message.created") {
        const info = (p.info as Record<string, unknown>) ?? (p.message as Record<string, unknown>) ?? p;
        const role = (info.role as string) ?? (info.type as string);
        if (role !== "assistant") return;
        const sid = (info.sessionID as string) ?? (p.sessionID as string);
        if (!sid) return;
        const tokens = (info.tokens as Record<string, unknown>) ?? (info.usage as Record<string, unknown>) ?? {};
        // Opencode DB uses tokens_input/output/cache_read/cache_write; SDK may use same or snake/camel variants
        const input = (tokens.input as number) ?? (tokens.input_tokens as number) ?? (tokens.inputTokens as number) ?? 0;
        const output = (tokens.output as number) ?? (tokens.output_tokens as number) ?? (tokens.outputTokens as number) ?? 0;
        const cacheRead = (tokens.cache_read as number) ?? (tokens.cache_read_tokens as number) ?? (tokens.cacheRead as number) ?? (tokens.cache_read_input_tokens as number) ?? 0;
        const cacheWrite = (tokens.cache_write as number) ?? (tokens.cache_write_tokens as number) ?? (tokens.cacheWrite as number) ?? (tokens.cache_creation_input_tokens as number) ?? 0;
        // Extract model
        const modelID = (info.modelID as string) ?? (info.model as string) ?? null;
        const providerID = (info.providerID as string) ?? (info.provider as string) ?? null;
        const modelRaw = modelID ? JSON.stringify({ id: modelID, providerID: providerID ?? "opencode" }) : modelID;
        // Even if tokens are 0, we still want a turn row for the assistant response
        fire({
          hook_event_name: "afterAgentResponse",
          session_id: sid,
          generation_id: (info.id as string) ?? (info.messageID as string) ?? \`msg-\${Date.now()}\`,
          model_id: modelRaw,
          model: modelID ?? null,
          input_tokens: input,
          output_tokens: output,
          cache_read_tokens: cacheRead,
          cache_write_tokens: cacheWrite,
        });
        return;
      }
    },
  };
};

export default { id: "token-lens", server: TokenLensPlugin };
`;
}

export function installOpenCodeHooks(projectRoot: string): { hooksJson: string; script: string } {
  const root = resolve(projectRoot);
  mkdirSync(PLUGIN_DIR, { recursive: true });
  mkdirSync(OPENCODE_CONFIG_DIR, { recursive: true });

  const pluginContent = pluginTemplate(root);
  writeFileSync(PLUGIN_PATH, pluginContent, "utf8");

  // Patch opencode.json plugin array
  let existing: Record<string, unknown> = {};
  let opencodeJsonExisted = existsSync(OPENCODE_JSON);
  if (opencodeJsonExisted) {
    try {
      existing = JSON.parse(readFileSync(OPENCODE_JSON, "utf8")) as Record<string, unknown>;
    } catch {
      // Backup corrupt file
      try { writeFileSync(`${OPENCODE_JSON}.bak`, readFileSync(OPENCODE_JSON, "utf8")); } catch {}
      existing = {};
    }
  } else {
    existing = { $schema: "https://opencode.ai/config.json" };
  }

  const pluginList = Array.isArray(existing.plugin) ? [...(existing.plugin as unknown[])] : [];
  // Use file:// URL for absolute path — opencode loader does dynamic import, file:// works for TS files
  // Also accept plain path as fallback
  const pluginEntry = `file://${PLUGIN_PATH}`;
  const altEntry = PLUGIN_PATH;
  const hasPlugin = pluginList.some((p) => {
    if (typeof p !== "string") return false;
    return p === pluginEntry || p === altEntry || p.includes("token-lens");
  });
  if (!hasPlugin) {
    pluginList.push(pluginEntry);
    existing.plugin = pluginList;
  }

  // Ensure $schema present
  if (!existing.$schema) existing.$schema = "https://opencode.ai/config.json";

  writeFileSync(OPENCODE_JSON, JSON.stringify(existing, null, 2) + "\n", "utf8");

  console.log(`[token-lens] OpenCode plugin installed.`);
  console.log(`  plugin: ${PLUGIN_PATH}`);
  console.log(`  config: ${OPENCODE_JSON}`);
  console.log(`  root:   ${root}`);
  console.log(`  Restart opencode for the plugin to load.`);

  return { hooksJson: OPENCODE_JSON, script: PLUGIN_PATH };
}
