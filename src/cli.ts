#!/usr/bin/env bun
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { homedir } from "os";
import { backfillAllProfiles, backfillIncrementalAll } from "./collector/backfill";
import { handleHook } from "./collector/hook";
import { installHooks } from "./collector/install-hooks";
import {
  loadUsageProfiles,
  SESSION_TOKEN_FILE,
  syncUsageProfiles,
  USAGE_PROFILES_FILE,
} from "./collector/sync-usage";
import { openMetricsDb, METRICS_DB_PATH, METRICS_DIR, discoverCursorStateDbs } from "./db/schema";
import { recomputeAllRollups } from "./db/queries";
import { invalidateOverviewCache } from "./db/overview-cache";
import { startServer } from "./server/api";
import type { HookPayload } from "./shared/types";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function readStdinJson(): Promise<HookPayload> {
  const raw = (await Bun.stdin.text()).trim();
  if (!raw) return {};
  return JSON.parse(raw) as HookPayload;
}

function usage(): void {
  console.log(`cursor-metrics — local Cursor chat session metrics

Usage:
  cursor-metrics backfill [--incremental|--full]  Import sessions from all Cursor profiles
                                            --incremental  skip unchanged composers (default for serve/cron)
                                            --full         wipe metrics tables and re-scan everything
  cursor-metrics sync-usage [--days N] [--profile .cur|.cursor|all]
                                            Fetch cache R/W via desktop login tokens (.cur / .cursor)
                                            Optional override: ${USAGE_PROFILES_FILE}
  cursor-metrics recompute                 Recalculate session costs (incl. cache token rates from prices.json)
  cursor-metrics serve [--port N] [--no-backfill]  API + dashboard; incremental backfill on start + every 15m
  cursor-metrics install-hooks             Wire user hooks at ~/.cursor/hooks.json
  cursor-metrics hook                      (internal) read hook JSON from stdin
  cursor-metrics export [--table sessions|session_rollups]  Export table to CSV (stdout)
  cursor-metrics cron install              Install 15-min launchd backfill cron (optional; serve already schedules)
  cursor-metrics cron uninstall            Remove launchd plist
  cursor-metrics cron status               Check if cron is loaded

Metrics DB: ${METRICS_DB_PATH}
Discovers: Application Support/Cursor|Cur + ~/.cursor|~/.cur globalStorage state.vscdb
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

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0] ?? "help";

  if (cmd === "help" || cmd === "-h" || cmd === "--help") {
    usage();
    return;
  }

  if (cmd === "install-hooks") {
    const result = installHooks(ROOT);
    console.log(`Installed hooks:\n  ${result.hooksJson}\n  ${result.script}`);
    return;
  }

  if (cmd === "hook") {
    const db = openMetricsDb();
    try {
      const payload = await readStdinJson();
      handleHook(db, payload);
      // Always allow — observational only
      process.stdout.write("{}\n");
    } catch (err) {
      console.error("[cursor-metrics hook]", err);
      process.stdout.write("{}\n");
    } finally {
      db.close();
    }
    return;
  }

  if (cmd === "backfill") {
    const full = args.includes("--full");
    const incremental = !full; // default resume; --full wipes
    const db = openMetricsDb();
    try {
      const paths = discoverCursorStateDbs();
      console.log(`Backfilling ${paths.length} Cursor profile DB(s) [${incremental ? "incremental" : "full"}]:`);
      for (const p of paths) console.log(`  ${p}`);
      const t0 = performance.now();
      const result = incremental ? await backfillIncrementalAll(db) : await backfillAllProfiles(db);
      const sec = ((performance.now() - t0) / 1000).toFixed(1);
      console.log(
        `Done in ${sec}s. sessions=${result.sessions} changed=${result.changed} token_bubbles=${result.bubbles} tool_calls=${result.toolCalls} estimated=${result.estimatedSessions}`,
      );
      console.log(`DB: ${METRICS_DB_PATH}`);
    } finally {
      db.close();
    }
    return;
  }

  if (cmd === "sync-usage") {
    const days = argNum(args, "--days") ?? 7;
    const profile = argStr(args, "--profile") ?? "all";
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
    const table = args[1] === "session_rollups" ? "session_rollups" : "sessions";
    const db = openMetricsDb();
    try {
      const rows = db.query(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
      if (!rows.length) {
        console.log("");
        process.exit(0);
      }
      const headers = Object.keys(rows[0]!);
      const escape = (v: unknown): string => {
        if (v == null) return "";
        const s = String(v);
        if (s.includes(",") || s.includes('"') || s.includes("\n")) {
          return `"${s.replace(/"/g, '""')}"`;
        }
        return s;
      };
      console.log(headers.join(","));
      for (const row of rows) {
        console.log(headers.map((h) => escape(row[h])).join(","));
      }
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
    const port = portIdx >= 0 ? Number(args[portIdx + 1]) : 3847;
    const noBackfill = args.includes("--no-backfill");
    const db = openMetricsDb();
    const dist = join(ROOT, "dashboard", "dist");
    const { port: bound } = startServer(db, { port, staticDir: dist });
    console.log(`cursor-metrics API on http://localhost:${bound}`);
    console.log(`Dashboard: http://localhost:${bound}/ (run dashboard:build if empty)`);
    console.log(`DB: ${METRICS_DB_PATH}`);
    console.log(
      noBackfill
        ? `Backfill: disabled (--no-backfill)`
        : `Backfill: on start, then every 15m (incremental)`,
    );
    const profiles = loadUsageProfiles();
    if (profiles.length) {
      console.log(`Usage sync: on start, then every 15m (${profiles.map((p) => p.name).join(", ")})`);
    } else {
      console.log(`Usage sync: skipped (configure ${USAGE_PROFILES_FILE})`);
    }

    const INTERVAL_MS = 15 * 60 * 1000;
    let syncing = false;
    const runIncremental = async () => {
      if (syncing) {
        console.log("[backfill] skip — previous run still in progress");
        return;
      }
      syncing = true;
      const t0 = performance.now();
      try {
        const result = await backfillIncrementalAll(db);
        const sec = ((performance.now() - t0) / 1000).toFixed(1);
        console.log(
          `[backfill] ${sec}s sessions=${result.sessions} changed=${result.changed} bubbles=${result.bubbles} tools=${result.toolCalls}`,
        );
        if (loadUsageProfiles().length) {
          const u0 = performance.now();
          const usages = await syncUsageProfiles(db, { days: 7 });
          const usec = ((performance.now() - u0) / 1000).toFixed(1);
          for (const usage of usages) {
            console.log(
              `[usage:${usage.profile}] ${usec}s events=${usage.events} cache_read=${usage.cacheReadTokens} cache_write=${usage.cacheWriteTokens} convs=${usage.conversations}`,
            );
          }
        }
      } catch (err) {
        console.error("[backfill] failed:", err);
      } finally {
        syncing = false;
      }
    };
    if (!noBackfill) {
      void runIncremental();
      setInterval(() => void runIncremental(), INTERVAL_MS);
    }

    // keep process alive
    await new Promise(() => {});
    return;
  }

  usage();
  process.exit(1);
}

export const CRON_PLIST_LABEL = "com.cursor-metrics.backfill";
export const CRON_PLIST_PATH = join(
  homedir(),
  "Library/LaunchAgents/com.cursor-metrics.backfill.plist",
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

  // Unload first if already loaded
  Bun.spawnSync(["launchctl", "bootout", `gui/${process.getuid?.() ?? process.pid}/${CRON_PLIST_LABEL}`], {
    stdio: ["ignore", "ignore", "ignore"],
  });

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
  if (!existsSync(CRON_PLIST_PATH)) {
    console.log("No cron plist found.");
    return;
  }
  const r = Bun.spawnSync(["launchctl", "bootout", `gui/${process.getuid?.() ?? process.pid}/${CRON_PLIST_LABEL}`], {
    stdio: ["inherit", "inherit", "inherit"],
  });
  unlinkSync(CRON_PLIST_PATH);
  if (r.exitCode === 0) {
    console.log("Cron uninstalled.");
  } else {
    console.log("Cron plist removed (launchctl reported issue).");
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
    console.log(`Cron: plist exists but NOT loaded. Run 'cursor-metrics cron install'.`);
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
