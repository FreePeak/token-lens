# Release 0.3.0 — OpenCode Live Hooks + Backfill Hardening

**Date:** 2026-08-20
**Bumps:** 0.2.0 → 0.3.0 (minor, new feature + fix)
**Related docs:** opencode-audit-2026-08-20.md, opencode-gap-analysis-2026-08-20.md, opencode-live-hook-design-2026-08-20.md

## Summary
Token-lens already had functional OpenCode **backfill** (422 sessions, 15k tool_calls, 1.3B tokens) but `install-hooks --tool opencode` was a stub (`🟡 Use backfill`). This release brings live capture to parity with Cursor/Claude Code, fixes a data-quality duplication bug, and adds incremental performance.

**Answer to original goal:** YES, token-lens **does** have OpenCode support (backfill + dashboard + CLI + tests). It was **missing only live hooks** — now implemented.

## What shipped

### P1 — Live plugin (new)
- **File:** `src/collector/install-hooks-opencode.ts` (rewritten, ~120 lines)
  - Creates `~/.config/opencode/plugins/token-lens.ts` from template
  - Patches `~/.config/opencode/opencode.json` `plugin` array (`file://...token-lens.ts`, deduped, backups on corrupt)
  - Returns `{hooksJson, script}` matching `Tool.installHooks` contract
  - Idempotent; re-running does not duplicate entries
- **Template:** `token-lens.ts` plugin (generated)
  - `Plugin = async ({client}) => ({ event: async ({event}) => {...}})`
  - Maps: `session.created → sessionStart`, `part.updated(type=tool, status completed) → postToolUse`, `message.updated(assistant) → afterAgentResponse`, `session.idle / session.status idle / session.deleted → sessionEnd`
  - Spawns `bun <root>/src/cli.ts hook --tool opencode` with `hook_source:"opencode"` payload (fallback to `node --import tsx` / `npx`)
  - Logs via `client.app.log` if available
- **Hook handler:** `src/collector/hook-opencode.ts` unchanged (already handled the 4 events); dispatcher `src/collector/hook.ts` already routes `hook_source==="opencode"` or `--tool opencode`
- **Verification:**
  ```bash
  bun run src/cli.ts install-hooks --tool opencode
  cat ~/.config/opencode/opencode.json | grep token-lens   # file://.../token-lens.ts
  ls ~/.config/opencode/plugins/token-lens.ts
  echo '{"hook_source":"opencode","hook_event_name":"sessionStart","session_id":"x"}' | bun src/cli.ts hook --tool opencode
  sqlite3 ~/.token-lens/metrics.db "SELECT * FROM sessions WHERE conversation_id='x'"
  ```

### P2 — Backfill idempotency fix (bug fix)
- **File:** `src/collector/opencode.ts` (MessageRow time fields, parseOpenCodeDb signature, wipe-before-insert, per-message timestamps)
- **Root cause:** `INSERT INTO tool_calls` has no UNIQUE constraint; re-running `backfill --tool opencode` appended duplicates. 1M+ tool_calls vs expected 15k.
- **Fix:** Inside per-session transaction, `DELETE FROM tool_calls / turns / token_snapshots (oc:*) WHERE conversation_id = ?` before re-insert. Recompute rollup after.
- **Verification:** `backfill --tool opencode` twice → `SELECT COUNT(*) FROM tool_calls WHERE profile='.opencode'` stable (15053). One-time `backfill --tool opencode --full` normalized DB from 1,021,816 → 15,053.

### P3 — Incremental resume (performance)
- **File:** `src/collector/opencode.ts` `backfillOpenCode` + `parseOpenCodeDb({resume})`
- **Before:** `void opts` — always full scan (4.3s for 422 sessions)
- **After:** If `resume===true`, builds `Map<conversation_id, last_backfilled_at>` and skips sessions where `time_updated <= last_backfilled_at`. Second incremental run in 0.0s with `tool_calls=0`.
- **CLI:** `backfill --tool opencode` is incremental (default); `--full` forces full.

### P4 — Per-message timestamps (UX)
- **File:** `src/collector/opencode.ts` `MessageRow.time_created/time_updated`
- **Before:** `upsertTurn` used `sess.time_created` for all turns (all turns shared same timestamp)
- **After:** Uses `m.time_created` / `m.time_updated` per message → session detail turn timeline now ordered correctly.

### P5 — Model normalization hardening (minor)
- Handles `providerID` variant in JSON; `firstUserPrompt` now handles `text`, `content`, and `parts` shapes.

### Docs & version
- `README.md`: Supported tools table row `OpenCode | 🟡 Use backfill` → `✅ (plugin)`; bullet adds `+ ~/.config/opencode/plugins/token-lens.ts for live capture`
- `package.json`: `0.2.0 → 0.3.0`
- `tests/hook-opencode.test.ts` (new, 6 tests) — synthetic payloads for each event + dispatcher routing
- Existing tests: `collector-opencode.test.ts` (5/5), `tools-registry.test.ts` (7/7), `overview-cache.test.ts` (5/5) all green

## API / Dashboard
- No dashboard code change needed — generic `listProfiles()` / `profile` filter already exposed `.opencode`. Verified via API smoke:
  - `GET /api/profiles` → `[".claude",".cursor",".opencode"]`
  - `GET /api/overview?profile=.opencode` → 422 sessions, 15k tool_calls, 106 USD estimated cost
  - `GET /api/sessions?profile=.opencode` → 422 rows
  - `GET /api/drivers?by=tool&profile=.opencode` → top tools

## Tradeoffs & known issues
- Plugin depends on `bun` on PATH; falls back to `node --import tsx` / `npx tsx`. If none available, plugin no-ops (logs).
- Plugin fires only on `part.state.status === completed|error` to avoid duplicate pending→completed double-count; if opencode changes pending semantics, may miss.
- Global plugin entry uses `file://` URL — opencode loader must support file import (verified via `leankg@git+...` pattern, but file:// not yet tested against live opencode server restart; manual restart required).
- Workspace dirty: repo has unrelated `M` files from other worktrees (Detail.tsx, Sessions.test.tsx, backfill.ts, claude-code.ts, etc.) that are NOT part of this release. They should be stashed or committed separately. This release's clean diff is limited to the files listed above.
- `prices.json` was auto-synced by `backfill` on 2026-08-20 (exit 0, 324ms) — revert if unintended (`git checkout -- prices.json`) before tagging.

## How to release (manual, requires user approval — not executed)

```bash
git diff --stat  # verify only intended files
git checkout -- prices.json  # if pricing sync was unintended
git add src/collector/install-hooks-opencode.ts src/collector/opencode.ts tests/hook-opencode.test.ts README.md package.json docs/plans/opencode-*.md docs/plans/release-0.3.0-opencode-live-hooks.md
git commit -m "feat(opencode): live plugin + incremental + dedup (0.3.0)"
git tag v0.3.0
git push && git push --tags
# optionally: bun run dashboard:build && git add dashboard/dist # if releasing built assets
```

## Testing checklist (done)
- [x] `bun run tests/collector-opencode.test.ts` 5/5
- [x] `bun run tests/tools-registry.test.ts` 7/7
- [x] `bun run tests/hook-opencode.test.ts` 6/6 (new)
- [x] `bun run tests/overview-cache.test.ts` 5/5
- [x] `bun run src/cli.ts backfill --tool opencode --full` → 422 sessions, 15053 tool_calls, 0 bubbles
- [x] `bun run src/cli.ts backfill --tool opencode` (incremental) → 0.0s, 0 tool_calls, counts stable
- [x] `bun run src/cli.ts install-hooks --tool opencode` → creates plugin + patches opencode.json idempotently
- [x] `echo hook payload | bun src/cli.ts hook --tool opencode` → writes session/turn/snapshot/rollup
- [x] API smoke (profiles, overview filtered, sessions, drivers) → all pass
- [x] `dashboard/dist` exists (prebuilt 2026-08-03)
