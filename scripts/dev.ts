// Dev orchestrator: runs the Bun API server (with --watch) and Vite dev server
// (with HMR) in parallel. Open http://localhost:5173 — Vite proxies /api to :3847.
//
// Usage: bun run scripts/dev.ts
//   Add --backfill (forwarded to serve) if you want an on-start data refresh.

const args = process.argv.slice(2);

const api = Bun.spawn(["bun", "--watch", "run", "src/cli.ts", "serve", ...args], {
  stdout: "inherit",
  stderr: "inherit",
});

const vite = Bun.spawn(["bun", "run", "dev"], {
  cwd: "dashboard",
  stdout: "inherit",
  stderr: "inherit",
});

const shutdown = () => {
  api.kill();
  vite.kill();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await Promise.race([api.exited, vite.exited]);
shutdown();
