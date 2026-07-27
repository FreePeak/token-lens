#!/usr/bin/env bun
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { backfillAllProfiles } from "./collector/backfill";
import { handleHook } from "./collector/hook";
import { installHooks } from "./collector/install-hooks";
import { openMetricsDb, METRICS_DB_PATH, discoverCursorStateDbs } from "./db/schema";
import { startServer } from "./server/api";
import type { HookPayload } from "./shared/types";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function readStdinJson(): Promise<HookPayload> {
  const chunks: Buffer[] = [];
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw) as HookPayload;
}

function usage(): void {
  console.log(`cursor-metrics — local Cursor chat session metrics

Usage:
  cursor-metrics backfill          Import historical sessions from all Cursor profile state.vscdbs
  cursor-metrics serve [--port N]  API + dashboard on http://localhost:3847
  cursor-metrics install-hooks     Wire user hooks at ~/.cursor/hooks.json
  cursor-metrics hook              (internal) read hook JSON from stdin

Metrics DB: ${METRICS_DB_PATH}
Discovers: Application Support/Cursor|Cur + ~/.cursor|~/.cur globalStorage state.vscdb
`);
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
    const db = openMetricsDb();
    try {
      const paths = discoverCursorStateDbs();
      console.log(`Backfilling ${paths.length} Cursor profile DB(s):`);
      for (const p of paths) console.log(`  ${p}`);
      const t0 = performance.now();
      const result = backfillAllProfiles(db);
      const sec = ((performance.now() - t0) / 1000).toFixed(1);
      console.log(
        `Done in ${sec}s. sessions=${result.sessions} token_bubbles=${result.bubbles} tool_calls=${result.toolCalls} estimated=${result.estimatedSessions} skipped_huge=${result.skippedHuge}`,
      );
      console.log(`DB: ${METRICS_DB_PATH}`);
    } finally {
      db.close();
    }
    return;
  }

  if (cmd === "serve") {
    const portIdx = args.indexOf("--port");
    const port = portIdx >= 0 ? Number(args[portIdx + 1]) : 3847;
    const db = openMetricsDb();
    const dist = join(ROOT, "dashboard", "dist");
    const { port: bound } = startServer(db, { port, staticDir: dist });
    console.log(`cursor-metrics API on http://localhost:${bound}`);
    console.log(`Dashboard: http://localhost:${bound}/ (run dashboard:build if empty)`);
    console.log(`DB: ${METRICS_DB_PATH}`);
    // keep process alive
    await new Promise(() => {});
    return;
  }

  usage();
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
