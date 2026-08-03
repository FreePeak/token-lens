// Dev orchestrator: runs the Bun API server (with --watch) on a single port.
// The API serves the dashboard from dashboard/dist, so the whole dev surface
// is exposed at http://localhost:5173 (API + UI on one origin).
//
// Usage: bun run scripts/dev.ts
//   Add --backfill (forwarded to serve) if you want an on-start data refresh.

const args = process.argv.slice(2);

const api = Bun.spawn(["bun", "--watch", "run", "src/cli.ts", "serve", ...args], {
  stdout: "inherit",
  stderr: "inherit",
});

const shutdown = () => {
  api.kill();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await api.exited;
shutdown();
