# Single PRD — token-lens

*Last updated: 2026-10-12 (added xdev/omp/pi session-log capture, tool-call latency + request/response bodies, Latency dashboard view, and assistant-ui transcript replay)*

## 1. What this is

Token Lens is a **local-first** dashboard for AI coding sessions. A Bun API
server (`src/`) plus a React/Vite dashboard (`dashboard/`) read session data
from each tool's own on-disk state, store it in `~/.token-lens/metrics.db`, and
serve it on `http://localhost:5173`. Nothing leaves the machine.

## 2. Supported tools

| Tool | Source | How data arrives |
|---|---|---|
| Cursor | `state.vscdb` globalStorage + `~/.cursor/hooks.json` | incremental backfill + live hooks |
| Claude Code | `~/.claude/projects/**/*.jsonl` + `settings.json` hooks | backfill (transcripts) + live hooks |
| OpenCode | `~/.local/share/opencode/opencode.db` + `opencode.json` plugin | backfill + live hooks |
| **xdev** | `~/.xdev/agent/sessions/<cwd>/*.jsonl` | backfill only |
| **omp** | `~/.omp/agent/sessions/<cwd>/*.jsonl` | backfill only |
| **pi** | `~/.pi/agent/sessions/<cwd>/*.jsonl` | backfill only |

xdev, omp and pi share one JSONL session-log contract (a `type:"session"`
header with `version:3`, then `type:"message"` lines linked by
`id`/`parentId`), so one parser (`src/collector/agent-session.ts`) and one
backfill collector (`src/collector/agent-backfill.ts`) cover all three. A tool
is an entry in the registry (`src/tools/registry.ts`).

## 3. What is measured

Per session: turns, tool calls, file reads, search/LeanKG calls, input /
output / cache-read / cache-write tokens, estimated cost, duration, first user
prompt, and the source file path.

Per **turn**: model, token counts, cost, ttft (`ttft_ms`) and duration
(`duration_ms`).

Per **tool call**: tool name (normalised), duration, ttfb, success, timestamp,
the **request** body and the **response** body (both capped at 8 KB, with a
`truncated` marker).

## 4. Dashboard

- **Overview** — aggregate stats, cost by model, top tools by call volume.
- **Sessions** — every conversation; adds a *P50 tool* column.
- **Drivers** — cost by tool / model / workspace.
- **Latency** (new) — overall p50/p90/p99/max + avg ttfb, failure rate, time
  spent in tools, and slowest tools by total time.
- **Detail** — stats, first prompt, token series, turn table, **tool-call
  replay** (assistant-ui thread rendering each tool's request/response), and
  the context-events timeline.

## 5. API surface

`/api/health` · `/api/profiles` · `/api/overview` · `/api/sessions` ·
`/api/sessions/:id` · `/api/drivers?by=` · `/api/latency` ·
`/api/latency/by-tool` · `/api/latency/sessions`.

`/api/sessions/:id` now includes `tool_calls[]` with `id, tool_name,
duration_ms, ttfb_ms, success, created_at, request, response, response_bytes,
truncated`.

## 6. Key decisions

- **Backfill over hooks for xdev/omp/pi.** Those tools have no hook API we are
  allowed to change (each is its own repo), and their full history is already on
  disk. Live capture remains Cursor + Claude Code + OpenCode only.
- **Capped bodies in SQLite** (8 KB per side). The whole point is local
  debugging of a tool call, not archiving every byte. `TOOL_CALL_BODY_CAP`
  (`src/db/queries.ts`) is the ceiling; the upgrade path is a sidecar file
  store if the cap ever proves too tight.
- **assistant-ui for the transcript view only.** The metrics views stay plain
  React, matching the rest of the dashboard; assistant-ui earns its 400 KB by
  rendering a real thread.
- **Session logs are replaced on re-import.** A resumed session log grows, so a
  re-backfill deletes the session's `tool_calls` rows before re-inserting
  (`DELETE FROM tool_calls WHERE conversation_id = ?`, inside the same
  transaction for Claude Code) instead of accumulating duplicates. Sessions
  still being written (mtime < 60 s) are skipped. Verified: two consecutive
  Claude Code backfills over the real install leave `tool_calls`, `turns` and
  `token_snapshots` unchanged.
- Percentiles are computed in JS over the (bounded) per-session duration lists
  rather than in SQL — no window-function SQLite version concerns, and the
  lists are small.

## 7. Status / roadmap

**Done:** Cursor + Claude Code + OpenCode backfill/hooks; Release 1
root-cause detectors; xdev/omp/pi session-log backfill; tool-call latency and
capped request/response capture; Latency dashboard view; assistant-ui
tool-call replay; multi-profile CLI export.

**Next:** live capture for xdev/omp/pi if those repos ever expose a hook API;
per-turn latency breakdown on the Detail view; a Debt ledger for the
deliberate ceilings marked with `ponytail:` comments.

## 8. Historical record

- `docs/root-cause-tdd-plan.md` — Release 1 TDD plan (turn cost + detectors).
- `docs/token-lens-root-cause-research.md` — root-cause research that drove it.
- `docs/plans/` — OpenCode audit/gap analysis, live-hook design, release notes.
