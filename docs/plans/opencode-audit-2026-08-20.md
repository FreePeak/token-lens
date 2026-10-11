# OpenCode Support Audit — token-lens

**Date:** 2026-08-20
**Repo:** FreePeak/token-lens (Bun + SQLite + React dashboard)
**Goal step 1: Audit existing OpenCode support**

## Files inspected
- `src/tools/opencode.ts` (registry entry)
- `src/collector/opencode.ts` (backfill, probe, normalize, parse)
- `src/collector/hook-opencode.ts` (live hook handler)
- `src/collector/hook.ts` (dispatcher)
- `src/collector/install-hooks-opencode.ts` (installer stub)
- `src/tools/registry.ts` (registration)
- `tests/collector-opencode.test.ts` (5 tests)
- `tests/tools-registry.test.ts` (opencode tool check)
- `README.md` (Supported tools table, CLI, pricing)
- `package.json` (keywords, scripts)
- `src/server/api.ts` + `dashboard/src/*` (profile filter generic)
- Live DB: `~/.local/share/opencode/opencode.db` (573MB, 422 sessions)

## Coverage matrix

| Area | Cursor | Claude Code | OpenCode | Verdict |
|------|--------|-------------|----------|---------|
| Tool registry | ✅ | ✅ | ✅ (`id: opencode`) | Complete |
| Backfill (historical) | ✅ (state.vscdb) | ✅ (JSONL) | ✅ (sqlite session+message+part) | Complete - 422 sessions ingested verified |
| Live hooks | ✅ (hooks.json + shell) | ✅ (settings.json + shell) | 🟡 Stub (prints guidance) | INCOMPLETE — speculative payload only |
| Install hooks | ✅ | ✅ | 🟡 Returns empty | INCOMPLETE — no plugin wiring |
| Hook dispatcher | ✅ | ✅ | ✅ (hook_source === "opencode") | Exists but never triggered by real opencode event |
| CLI `backfill --tool opencode` | ✅ | ✅ | ✅ | Works |
| CLI `install-hooks --tool opencode` | ✅ | ✅ | 🟡 prints guidance | Stub |
| Tests | ✅ | ✅ (4+ tests) | ✅ (5 tests + registry) | Adequate for backfill |
| Dashboard profile filter | ✅ generic | ✅ | ✅ generic (`listProfiles()` returns .opencode) | Works |
| Cost estimation | ✅ via prices.json | ✅ | ✅ via recomputeRollup (tokens from session table) | Works, but uses session cost=0 fallback? Verified: recomputeRollup estimates from tokens |
| Tool call attribution | ✅ (hook + vscdb) | ✅ (JSONL) | ✅ (part.type='tool') | Works — 15053 tool_calls verified |
| Docs | ✅ | ✅ | ✅ table row + what we read | Accurate but notes 🟡 Use backfill |

## Backfill deep dive (opencode.ts:1-318)
- Probe: checks sqlite_master for session+part tables → ok
- Discover: 3 candidates XDG-first → ok, but only returns first match (single DB). Correct — opencode uses single DB.
- Model normalize: parses JSON `{id, providerID, variant}` → flat id. Handles fallback to modelID. Edge: if DB stores `model` as plain string (older versions) returns raw — ok.
- Session loop: reads session rows, then message/part per session → N+1 query but fine for 422 sessions (12s total for all tools).
- Token snapshot: single summary bubble `oc:<time>:summary` per session using aggregated tokens. Linked to first assistant message id. Works.
- Turns: creates one turn per message row (user+assistant count). Uses `sess.time_created` for ended_at (no per-message timestamp). Gap: could use message time_created instead for better timeline.
- Tool calls: from `part` where type='tool', label via normalizeToolLabel, success via metadata.exit / status. Good.
- Idempotency: uses upsertSession/TokenSnapshot/Turn/ToolCall + recomputeRollup per session inside transaction → re-runs should be idempotent but tool_calls may duplicate? insertToolCall may create dup if re-run without clearing — need check.

## Hook deep dive (hook-opencode.ts:1-130)
- Events: sessionStart, sessionEnd, postToolUse, afterAgentResponse → matches Cursor/Claude envelope
- Payload shape: expects conversation_id/session_id, model_id, workspace_path, tool_name/tool_input, tokens → same as other hooks. isOpenCodePayload checks hook_source==='opencode'.
- Gap: No real OpenCode plugin emits this shape. OpenCode plugin API (from @opencode-ai/plugin 1.18.16) uses event types like `session.created`, `session.idle`, `message.updated`, `session.error`, etc. — not hook_event_name. So current hook would never be called by a real plugin without translation.

## Installer gap
- Current installOpenCodeHooks just logs and returns empty strings. Does not create ~/.config/opencode/plugins/token-lens.ts nor modify opencode.json plugin array. User must manually run backfill.
- Since opencode now has stable plugin system (Plugin = (input)=>Hooks, events), we could generate a real plugin that translates opencode events → token-lens hook payloads → either HTTP to Bun API or direct DB write via bun:sqlite.

## Dashboard/API
- Generic profile filter (api.ts profile() helper, listProfiles(), listSessions filter) → automatically supports any tool id. Verified: API returns .opencode, .claude, .cursor profiles. Dashboard Vite proxy works.

## Risks / known issues
- Moderate: Live hooks stub means real-time capture missing; but serve's 15m incremental backfill mitigates (serve spawns backfill child every 15m).
- Low: Tool call duplication on re-backfill? insertToolCall may append duplicate tool_calls on each run (needs ON CONFLICT handling?). Claude Code backfill uses per-session upsert pattern but also inserts tool_calls without dedupe? Need to verify DB schema for tool_calls uniqueness.
- Low: Model pricing uncertainty: session.cost from opencode DB is ignored (COALESCE cost,0 but not stored as rollup cost — recomputeRollup recomputes from tokens via prices.json). That's intentional (unify cost model). Verified rollup total_cost_usd computed >=0.
- Low: Backfill resume flag ignored (void opts) — always does full scan. Ok for 422 sessions but should support incremental via last_backfilled_at check for scale.

## Conclusion for step 1
- **OpenCode support EXISTS and is FUNCTIONAL for backfill (historical) and dashboard.**
- **Live hooks are NOT functionally complete** — stub only. This is the only missing parity vs Cursor/Claude Code.
- Next steps: gap analysis (step 3) should rank live-hook plugin as P1, with optional hardening (idempotency, incremental resume, per-message timestamps).
