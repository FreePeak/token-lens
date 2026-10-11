# Gap Analysis: OpenCode vs Cursor/Claude Code parity

## Summary
OpenCode backfill is ✅ complete and production-tested (422 sessions, 1.3B tokens-ish aggregate). The only missing parity is live incremental capture; everything else is hardening.

## Ranked gaps

### P1 — Live hooks stub (no real plugin) — MUST FIX for full support
- **Current:** `install-hooks-opencode.ts` just console.log + returns empty strings. `hook-opencode.ts` expects speculative payload (`hook_event_name`, `hook_source==="opencode"`) that no OpenCode event ever emits.
- **OpenCode reality:** `@opencode-ai/plugin` 1.18.16 exposes `Plugin = (input:PluginInput)=>Hooks`, with `Hooks.event` receiving `event.type ∈ { "server.connected", "session.created", "session.updated", "session.deleted", "session.status", "session.idle", "session.error", "message.updated", "message.removed", "part.updated", "part.removed", "permission.updated", "permission.replied", ... }` (see auto-retry plugin and SDK). Plugins are registered via `opencode.json: { "plugin": ["my-plugin@..."] }` or local file under `~/.config/opencode/plugins/*.ts` or project `.opencode/plugins`.
- **Parity vs Claude Code:** Claude hooks use `~/.claude/settings.json` shell commands that pipe JSON stdin to `bun src/cli.ts hook --tool claude-code`. OpenCode's shell-hook model doesn't exist; plugin must call token-lens via child process or HTTP.
- **Design fix:**
  - Create `~/.config/opencode/plugins/token-lens.ts` template that:
    - On `session.created` → upsert session (start)
    - On `part.updated` where `part.type==="tool"` → insert tool_call
    - On `message.updated` where usage present → upsert token_snapshot + turn
    - On `session.idle` / `session.status` idle → finalize duration
    - Implementation: spawn `bun <token-lens root>/src/cli.ts hook --tool opencode` with JSON payload, same envelope as `hook-opencode.ts` expects (so dispatcher stays). Or directly write to `~/.token-lens/metrics.db` via `bun:sqlite` to avoid Bun.spawn overhead (choose spawn for isolation).
  - Installer `installOpenCodeHooks` should:
    - Resolve token-lens project root
    - Write plugin file to `~/.config/opencode/plugins/token-lens.ts` (mkdir -p)
    - Patch `~/.config/opencode/opencode.json` to add `"plugin": ["file://<path>"]` or local plugin entry (preserve existing plugins like `leankg@...`)
    - Return `{hooksJson, script}` pointing to plugin file
  - Hook handler stays, but needs mapping from OpenCode event → payload (new helper `translateOpenCodeEvent`).
- **Verification:** `bun run install-hooks --tool opencode` creates file and updates opencode.json; a synthetic `echo '{"hook_source":"opencode","hook_event_name":"sessionStart","session_id":"test"}' | bun src/cli.ts hook --tool opencode` writes session row.

### P2 — Tool_calls duplication on re-backfill — MUST FIX (data-quality)
- **Current:** `parseOpenCodeDb` inserts tool_calls with `INSERT INTO tool_calls` (no upsert). Cursor's `backfillIncrementalAll` does `wipeConversationDerived` before re-importing changed sessions; OpenCode's `backfillOpenCode` does NOT wipe — it just appends. Second backfill of 422 sessions added +15053 tool_calls (verified: 1006763→1021816).
- **Fix:** Add `DELETE FROM tool_calls WHERE conversation_id IN (...)` + `DELETE FROM turns`, `DELETE FROM token_snapshots WHERE bubble_id GLOB 'oc:*'` before re-parsing each session, scoped to the sessions being re-imported (not global wipe). Same pattern as `wipeConversationDerived` but for `.opencode` profile. Also add index on `tool_calls(conversation_id, generation_id)`? Currently only index on conv and name. Could also add UNIQUE constraint on `(conversation_id, generation_id, tool_name, created_at)` but simpler to wipe per session inside transaction before insert.
- **Verification:** Run `bun run tests/collector-opencode.test.ts` + manual double backfill yields same `COUNT(*) FROM tool_calls WHERE profile='.opencode'` before/after.

### P3 — Incremental resume ignored — SHOULD FIX (performance)
- **Current:** `backfillOpenCode(opts)` does `void opts` and always scans full `session` table (422 rows) + per-session message/part queries. Cursor's incremental skips unchanged composers via `last_backfilled_at <= lastUpdatedAt`.
- **Fix:** If `opts.resume===true`, fetch `Map<conversation_id, last_backfilled_at>` from metrics DB and skip sessions where `sess.time_updated <= last_backfilled_at`. Return early if none changed. This cuts 12s backfill to <1s for steady state.
- **Verification:** Second `backfill --tool opencode --incremental` with no new sessions should log `0 changed — skip scan` and DB counts unchanged.

### P4 — Per-message timestamps not preserved — SHOULD FIX (UX detail)
- **Current:** `upsertTurn` uses `sess.time_created` for `ended_at` for all turns in a session (line 252). Message table has `time_created`/`time_updated` per row.
- **Fix:** Use each message's `time_created` (and `time_updated` for ended) instead of session time. For tool_calls, uses `p.time_created` already correct.
- **Verification:** Session detail for a multi-turn opencode session shows increasing turn `ended_at` values matching `message.time_created`.

### P5 — Model cost fallback ignores `session.cost` — CONSIDER (pricing accuracy)
- **Current:** `parseOpenCodeDb` reads `cost` but never stores it; `recomputeRollup` recomputes cost from `tokens_*` via `prices.json`. Opencode's `cost` may include provider-billed cost (more accurate than estimate). Should we store `session.cost` in rollup when tokens missing or pricing unknown? Current fallback is `estimateCostUsd` with model from `session.model` JSON.
- **Decision:** Keep estimate path but use `cost` as fallback when `total_tokens===0` or model unknown. Add field `session_rollups.total_cost_usd = MAX(estimate, session.cost)` or store raw cost if estimate 0.
- **Verification:** Session with 0 tokens but `cost>0` shows non-zero cost after recompute.

### P6 — Dashboard/docs minor polish — NICE TO HAVE
- README already correct (✅ Complete / 🟡 Use backfill). After P1, update to `✅ (plugin)` for live hooks.
- Dashboard profile buttons generic → no change needed.
- Add `tests/hook-opencode.test.ts` for payload translation.

## Feasibility of plugin API
- **Stable?** Yes — opencode 1.18.16 plugin API is stable (used by LeanKG, auto-retry). Events observed in `auto-retry.ts.bak`: `server.connected`, `session.error`, `session.status`, `session.idle`, `message.updated`. That's sufficient.
- **Risk:** Plugin file must be TypeScript compiled by opencode (Bun). Provide simple JS with no external deps except `child_process` spawn.
- **Alternative:** Polling backfill every 15m (current serve) already covers near-real-time; plugin is optimization for immediate dashboard update.

## Effort estimate
| Gap | Files | Effort |
|-----|-------|--------|
| P1 live plugin | install-hooks-opencode.ts, new plugins/token-lens-opencode.ts template, hook-opencode.ts translate | ~150 lines |
| P2 dedup wipe | opencode.ts | ~30 lines |
| P3 resume | opencode.ts | ~20 lines |
| P4 timestamps | opencode.ts | ~10 lines |
| Tests/docs | tests/*, README | ~50 lines |
