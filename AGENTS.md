# AGENTS.md

## Cursor Cloud specific instructions

Token Lens is a **local-first** tool: a Bun API server (`src/`) + a React/Vite dashboard (`dashboard/`). Its normal data source is Cursor's local `state.vscdb`, which does **not** exist on cloud VMs — so `backfill` finds nothing and the metrics DB (`~/.token-lens/metrics.db`) starts empty. That is expected here, not a bug.

Runtime: **Bun** (installed at `~/.bun/bin`). The startup update script runs `bun install` in the repo root and in `dashboard/`; you should not need to reinstall.

### Run

- Dev (recommended): `bun run dev` (or `make dev`) runs the API with `--watch` on `http://localhost:5173`, serving both the API and the built dashboard from `dashboard/dist` on a single port. Edits in `src/` restart the API; for UI changes run `cd dashboard && bun run dev` separately to get Vite HMR, or rebuild with `make dashboard-build`.
- Prod-style: `bun run serve` serves the built UI on `:5173`, but you must build first with `cd dashboard && bun run build` (writes `dashboard/dist/`), otherwise the dashboard route is empty.

### Getting data without Cursor (for testing UI/pipeline)

There is no Cursor session data on cloud VMs. To exercise the ingest → SQLite → rollup → API → dashboard pipeline, feed the **live-capture hook path** directly (this is exactly how Cursor streams events): pipe a JSON payload per event to `bun run src/cli.ts hook`. Useful `hook_event_name` values: `sessionStart`, `postToolUse`, `afterAgentResponse` (carries `input_tokens`/`output_tokens`/`cache_read_tokens`/`cache_write_tokens`), `stop`, `sessionEnd`. Use a `model_id` present in `prices.json` so cost is estimated. Data then shows up at `/api/overview`, `/api/sessions`, and in the dashboard.

### Test

- No CI, no lint config, no git hooks in this repo. The checks are two Bun test files:
  - `bun run tests/overview-cache.test.ts` (also `make test`)
  - `bun run tests/tools-registry.test.ts`
- Root `bunx tsc --noEmit` reports **pre-existing** `bun:sqlite` named-binding type errors in `src/analyze.ts` and `src/db/*`. These are not part of the project's workflow and are unrelated to environment setup — do not treat them as introduced by your changes.

### Gotchas

- `backfill` (and `serve`, which backfills on start + every 15m) auto-runs a price sync that can **modify `prices.json`** in the working tree. Revert that side-effect (`git checkout -- prices.json`) if you didn't intend to commit pricing changes.
- `sync-usage` and `cron install` are macOS/launchd-oriented and need a real Cursor desktop login token (`~/.token-lens/usage-profiles.json`); they are not usable on a cloud VM.
