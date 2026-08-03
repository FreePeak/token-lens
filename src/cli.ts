#!/usr/bin/env bun
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "fs";
import { homedir } from "os";
import { openMetricsDb, METRICS_DB_PATH, METRICS_DIR } from "./db/schema";
import { listProfiles, recomputeAllRollups } from "./db/queries";
import { invalidateOverviewCache } from "./db/overview-cache";
import { startServer } from "./server/api";
import { listTools, getTool } from "./tools/registry";
import { syncPricesIfStale } from "./shared/price-sync";
import type { HookPayload } from "./shared/types";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function readStdinJson(): Promise<HookPayload> {
  const raw = (await Bun.stdin.text()).trim();
  if (!raw) return {};
  return JSON.parse(raw) as HookPayload;
}

function usage(): void {
  const toolNames = listTools().map((t) => t.id).join("|");
  console.log(`token-lens — local AI coding session metrics

Usage:
  token-lens backfill [--incremental|--full] [--tool ${toolNames}]
                                            Import sessions from one or all tools.
                                            --incremental  skip unchanged sessions (default)
                                            --full         wipe metrics tables and re-scan
  token-lens sync-usage [--days N] [--profile .cur|.cursor|all]
                                            Fetch cache R/W via desktop login tokens (Cursor)
                                            Optional override: ~/.token-lens/usage-profiles.json
  token-lens recompute                   Recalculate session costs (incl. cache token rates from prices.json)
  token-lens serve [--port N] [--no-backfill]  API + dashboard; incremental backfill on start + every 15m
  token-lens install-hooks [--tool ID]    Wire tool hooks at the tool's hooks config
  token-lens hook                        (internal) read hook JSON from stdin
  token-lens export [sessions|session_rollups] [--profile NAME] [--list-profiles|-L]
                                            Export table to CSV (stdout)
  token-lens cron install                Install 15-min launchd backfill cron (optional; serve already schedules)
  token-lens cron uninstall              Remove launchd plist
  token-lens cron status                 Check if cron is loaded

Metrics DB: ${METRICS_DB_PATH}
Tools: ${listTools().map((t) => `${t.id} (${t.displayName})`).join(", ")}
Cursor state: Application Support/Cursor|Cur + ~/.cursor|~/.cur globalStorage state.vscdb
`);
}

function argNum(args: string[], flag: string): number | undefined {
  const i = args.indexOf(flag);
  if (i < 0) return undefined;
  const n = Number(args[i + 1]);
  return Number.isFinite(n) ? n : undefined;
}

function argStr(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i < 0) return undefined;
  return args[i + 1];
}

type ExportTable = "sessions" | "session_rollups";

export function parseExportArgs(args: string[]): {
  table: ExportTable;
  profile?: string;
  listProfiles: boolean;
} {
  let table: ExportTable = "sessions";
  let profile: string | undefined;
  let listProfiles = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--profile") {
      profile = args[i + 1];
      i++;
    } else if (arg === "--list-profiles" || arg === "-L") {
      listProfiles = true;
    } else if (arg === "sessions" || arg === "session_rollups") {
      table = arg;
    }
  }
  return { table, profile, listProfiles };
}

export function exportTableCsv(
  db: ReturnType<typeof openMetricsDb>,
  table: ExportTable,
  profile?: string,
): string {
  const sql = `SELECT * FROM ${table}${profile ? " WHERE profile = ?" : ""}`;
  const rows = (profile ? db.query(sql).all(profile) : db.query(sql).all()) as Record<string, unknown>[];
  if (!rows.length) return "\n";
  const headers = Object.keys(rows[0]!);
  const escape = (value: unknown): string => {
    if (value == null) return "";
    const text = String(value);
    if (text.includes(",") || text.includes('"') || text.includes("\n")) {
      return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
  };
  return `${[
    headers.join(","),
    ...rows.map((row) => headers.map((header) => escape(row[header])).join(",")),
  ].join("\n")}\n`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0] ?? "help";

  if (cmd === "help" || cmd === "-h" || cmd === "--help") {
    usage();
    return;
  }

  if (cmd === "install-hooks") {
    const toolId = argStr(args, "--tool") ?? "cursor";
    const tool = getTool(toolId);
    if (!tool?.installHooks) {
      console.error(`token-lens: tool "${toolId}" does not support install-hooks`);
      process.exit(1);
    }
    const result = tool.installHooks(ROOT);
    console.log(`Installed hooks:\n  ${result.hooksJson}\n  ${result.script}`);
    return;
  }

  if (cmd === "hook") {
    const toolFlag = argStr(args, "--tool");
    const db = openMetricsDb();
    try {
      const payload = await readStdinJson();
      // Hook is dispatched by the tool's own shell wrapper; the dispatcher
      // routes by --tool flag or by sniffing the payload shape.
      const { handleHook } = await import("./collector/hook");
      handleHook(db, payload, toolFlag);
      process.stdout.write("{}\n");
    } catch (err) {
      console.error("[token-lens hook]", err);
      process.stdout.write("{}\n");
    } finally {
      db.close();
    }
    return;
  }

  if (cmd === "backfill") {
    const full = args.includes("--full");
    const incremental = !full; // default resume; --full wipes
    const toolFilter = argStr(args, "--tool");
    const tools = toolFilter ? [getTool(toolFilter)].filter((t): t is NonNullable<typeof t> => !!t) : listTools();
    if (!tools.length) {
      console.error(`token-lens: no tools match "${toolFilter ?? "all"}". Known: ${listTools().map((t) => t.id).join(", ")}`);
      process.exit(1);
    }
    const db = openMetricsDb();
    try {
      const sync = syncPricesIfStale();
      if (sync.ran) console.log(`[prices] auto-synced (exit ${sync.exitCode}, ${sync.durationMs}ms)`);
      console.log(`Backfilling ${tools.length} tool(s) [${incremental ? "incremental" : "full"}]: ${tools.map((t) => t.id).join(", ")}`);
      const t0 = performance.now();
      let sessions = 0, bubbles = 0, toolCalls = 0, changed = 0;
      for (const tool of tools) {
        try {
          const r = await tool.backfill(db, { resume: incremental, rollup: true });
          sessions += r.changed;
          bubbles += r.bubbles;
          toolCalls += r.toolCalls;
          changed += r.changed;
        } catch (err) {
          console.error(`[${tool.id}] backfill failed:`, err instanceof Error ? err.message : err);
        }
      }
      const sec = ((performance.now() - t0) / 1000).toFixed(1);
      console.log(`Done in ${sec}s. sessions=${changed} bubbles=${bubbles} tool_calls=${toolCalls}`);
      console.log(`DB: ${METRICS_DB_PATH}`);
    } finally {
      db.close();
    }
    return;
  }

  if (cmd === "sync-usage") {
    const days = argNum(args, "--days") ?? 30;
    const profile = argStr(args, "--profile") ?? "all";
    const { loadUsageProfiles, syncUsageProfiles, SESSION_TOKEN_FILE, USAGE_PROFILES_FILE } = await import("./collector/sync-usage");
    if (!loadUsageProfiles().length) {
      console.error(
        `Missing usage profiles.\n  Write ${USAGE_PROFILES_FILE} with ".cur" / ".cursor" tokens\n  or: export CURSOR_SESSION_TOKEN=… / ${SESSION_TOKEN_FILE}`,
      );
      process.exit(1);
    }
    const db = openMetricsDb();
    try {
      console.log(`Syncing usage events (last ${days}d, profile=${profile})…`);
      const t0 = performance.now();
      const results = await syncUsageProfiles(db, { days, profile });
      const sec = ((performance.now() - t0) / 1000).toFixed(1);
      for (const result of results) {
        console.log(
          `  [${result.profile}] pages=${result.pages} events=${result.events} with_cache=${result.withCache} convs=${result.conversations} cache_read=${result.cacheReadTokens} cache_write=${result.cacheWriteTokens}`,
        );
      }
      console.log(`Done in ${sec}s. DB: ${METRICS_DB_PATH}`);
    } finally {
      db.close();
    }
    return;
  }

  if (cmd === "recompute") {
    const db = openMetricsDb();
    try {
      const t0 = performance.now();
      const n = await recomputeAllRollups(db);
      invalidateOverviewCache(db);
      const sec = ((performance.now() - t0) / 1000).toFixed(1);
      console.log(`Recomputed ${n} session rollups in ${sec}s (prices.json + cache tokens).`);
      console.log(`DB: ${METRICS_DB_PATH}`);
    } finally {
      db.close();
    }
    return;
  }

  if (cmd === "export") {
    const options = parseExportArgs(args.slice(1));
    const db = openMetricsDb();
    try {
      if (options.listProfiles) {
        const profiles = listProfiles(db);
        if (profiles.length) process.stdout.write(`${profiles.join("\n")}\n`);
        return;
      }
      process.stdout.write(exportTableCsv(db, options.table, options.profile));
    } finally {
      db.close();
    }
    return;
  }

  if (cmd === "cron") {
    const sub = args[1] ?? "status";
    switch (sub) {
      case "install":
        installCron();
        break;
      case "uninstall":
        uninstallCron();
        break;
      case "status":
        cronStatus();
        break;
      default:
        console.log(`Unknown cron subcommand: ${sub}. Use: install, uninstall, status`);
        process.exit(1);
    }
    return;
  }

  if (cmd === "serve") {
    const portIdx = args.indexOf("--port");
    const port = portIdx >= 0 ? Number(args[portIdx + 1]) : 5173;
    const noBackfill = args.includes("--no-backfill");
    const db = openMetricsDb();
    const dist = join(ROOT, "dashboard", "dist");
    const { port: bound } = startServer(db, { port, staticDir: dist });
    console.log(`token-lens API on http://localhost:${bound}`);
    console.log(`Dashboard: http://localhost:${bound}/ (run dashboard:build if empty)`);
    console.log(`DB: ${METRICS_DB_PATH}`);
    console.log(
      noBackfill
        ? `Backfill: disabled (--no-backfill)`
        : `Backfill: on start, then every 15m (incremental)`,
    );
    const { loadUsageProfiles, USAGE_PROFILES_FILE } = await import("./collector/sync-usage");
    const profiles = loadUsageProfiles();
    if (profiles.length) {
      console.log(`Usage sync: on start, then every 15m (${profiles.map((p) => p.name).join(", ")})`);
    } else {
      console.log(`Usage sync: skipped (configure ${USAGE_PROFILES_FILE})`);
    }

    if (!noBackfill) {
      const INTERVAL_MS = 15 * 60 * 1000;
      let running = false;

      const pump = (stream: ReadableStream<Uint8Array>, target: NodeJS.WriteStream) => {
        const reader = stream.getReader();
        const read: () => Promise<void> = () => reader.read().then(({ done, value }) => {
          if (done) return;
          target.write(value);
          return read();
        }).catch(() => {});
        read();
      };

      const spawnAll = () => {
        if (running) {
          console.log("[backfill] skip — previous run still in progress");
          return;
        }
        running = true;
        const t0 = performance.now();

        const child = Bun.spawn(
          [process.execPath, "run", join(ROOT, "src/cli.ts"), "backfill", "--incremental"],
          { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } },
        );
        pump(child.stdout, process.stdout);
        pump(child.stderr, process.stderr);

        child.exited.then((code) => {
          const sec = ((performance.now() - t0) / 1000).toFixed(1);
          console.log(`[backfill] child done (exit ${code}) in ${sec}s`);
          if (!profiles.length) { running = false; return; }

          const u0 = performance.now();
          const uchild = Bun.spawn(
            [process.execPath, "run", join(ROOT, "src/cli.ts"), "sync-usage", "--days", "30"],
            { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } },
          );
          pump(uchild.stdout, process.stdout);
          pump(uchild.stderr, process.stderr);
          uchild.exited.then((ucode) => {
            console.log(`[usage] sync done (exit ${ucode}) in ${((performance.now() - u0) / 1000).toFixed(1)}s`);
            running = false;
          });
        });
      };

      void spawnAll();
      setInterval(() => void spawnAll(), INTERVAL_MS);
    }

    // keep process alive
    await new Promise(() => {});
    return;
  }

  usage();
  process.exit(1);
}

export const CRON_PLIST_LABEL = "com.token-lens.backfill";
export const CRON_PLIST_PATH = join(
  homedir(),
  "Library/LaunchAgents/com.token-lens.backfill.plist",
);

function cronPlist(bunPath: string, scriptPath: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${CRON_PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${bunPath}</string>
    <string>run</string>
    <string>${scriptPath}</string>
    <string>backfill</string>
    <string>--incremental</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${ROOT}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${homedir()}</string>
    <key>PATH</key>
    <string>${process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin"}</string>
  </dict>
  <key>StartInterval</key>
  <integer>900</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>AbandonProcessGroup</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${join(METRICS_DIR, "cron.log")}</string>
  <key>StandardErrorPath</key>
  <string>${join(METRICS_DIR, "cron.log")}</string>
  <key>LowPriorityIO</key>
  <true/>
  <key>Nice</key>
  <integer>10</integer>
</dict>
</plist>`;
}

function installCron(): void {
  const launchDir = join(homedir(), "Library/LaunchAgents");
  mkdirSync(launchDir, { recursive: true });

  // Use explicit path resolution so launchd always finds Bun regardless of PATH
  const bunPath = process.execPath;
  const scriptPath = join(ROOT, "src/cli.ts");

  const plist = cronPlist(bunPath, scriptPath);
  writeFileSync(CRON_PLIST_PATH, plist, "utf-8");
  console.log(`Wrote ${CRON_PLIST_PATH}`);

  // Unload first if already loaded (works for old `com.cursor-metrics.backfill` label too)
  const oldLabels = ["com.cursor-metrics.backfill", CRON_PLIST_LABEL];
  for (const label of oldLabels) {
    Bun.spawnSync(["launchctl", "bootout", `gui/${process.getuid?.() ?? process.pid}/${label}`], {
      stdio: ["ignore", "ignore", "ignore"],
    });
  }

  const result = Bun.spawnSync(["launchctl", "bootstrap", `gui/${process.getuid?.() ?? process.pid}`, CRON_PLIST_PATH], {
    stdio: ["inherit", "inherit", "inherit"],
  });
  if (result.exitCode === 0) {
    console.log("Cron installed. Runs every 15 minutes (900s).");
  } else {
    console.error("Cron install failed (bootstrap).");
  }
}

function uninstallCron(): void {
  const labels = [CRON_PLIST_LABEL, "com.cursor-metrics.backfill"];
  for (const label of labels) {
    Bun.spawnSync(["launchctl", "bootout", `gui/${process.getuid?.() ?? process.pid}/${label}`], {
      stdio: ["ignore", "ignore", "ignore"],
    });
  }
  if (existsSync(CRON_PLIST_PATH)) {
    unlinkSync(CRON_PLIST_PATH);
    console.log("Cron uninstalled.");
  } else {
    console.log("No cron plist found.");
  }
}

function cronStatus(): void {
  const r = Bun.spawnSync(["launchctl", "print", `gui/${process.getuid?.() ?? process.pid}/${CRON_PLIST_LABEL}`], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const loaded = r.exitCode === 0;
  const plist = existsSync(CRON_PLIST_PATH);
  if (loaded) {
    console.log(`Cron: LOADED. Runs every 900s (15min).`);
  } else if (plist) {
    console.log(`Cron: plist exists but NOT loaded. Run 'token-lens cron install'.`);
  } else {
    console.log(`Cron: NOT installed.`);
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
