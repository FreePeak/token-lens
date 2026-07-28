# Cursor Metrics

Local dashboard for every Cursor chat session: **turns**, **tool calls**, **file reads**, **input/output tokens**, and **estimated cost** — same shape as the Alamofire benchmark report.

All data stays on your machine. Nothing is uploaded.

## Quick start

Requires [Bun](https://bun.sh).

```bash
cd cursor-metrics
bun install
cd dashboard && bun install && cd ..

# Import historical chats from all discovered Cursor profile DBs
bun run backfill

# Wire live capture (user-level hooks for all projects)
bun run install-hooks
# Restart Cursor once so hooks load

# Build UI + serve API
cd dashboard && bun run build && cd ..
bun run serve
```

Open [http://localhost:3847](http://localhost:3847).

Dev UI (API must be running): `bun run serve` in one terminal, `cd dashboard && bun run dev` in another.

## What it measures

| Metric | Live (hooks) | Historical (backfill) |
|--------|--------------|------------------------|
| Turns | `stop` / `afterAgentResponse` | Assistant bubbles |
| Tool calls | `postToolUse` | Bubble `toolResults` when present |
| File reads | Tool name `Read` / `TabRead` | Same |
| Tokens (in/out) | `afterAgentResponse` `input_tokens` / `output_tokens` | Bubble `tokenCount` when non-zero |
| Cache read/write tokens | `afterAgentResponse` **or** `sync-usage` (dashboard API) | `bun run sync-usage` (see below) |
| Cost | Estimated via `prices.json` (+ 0.1×/1.25× input for cache R/W when unset) | Same |
| Duration | `sessionStart` → `sessionEnd` | Header timestamps |

### Prompt-cache tokens (important)

Cursor’s local `state.vscdb` bubbles only persist `tokenCount: { inputTokens, outputTokens }`. Runtime fields `cacheReadTokens` / `cacheWriteTokens` are **not** written to bubble JSON.

**Historical cache tokens** come from Cursor’s dashboard API. Auth is read automatically from local app logins:

| Profile | Token source |
|---------|----------------|
| `.cur` | `~/.cur/.../state.vscdb` → `cursorAuth/accessToken` |
| `.cursor` | `~/Library/Application Support/Cursor/.../state.vscdb` → `cursorAuth/accessToken` (+ `cachedTeam`) |

```bash
bun run sync-usage                         # both profiles, last 7 days
bun run sync-usage -- --profile .cursor
bun run sync-usage -- --profile .cur
bun run recompute
```

Optional `~/.cursor-metrics/usage-profiles.json` can set `teamId` / `userId` only (desktop token stays authoritative). Legacy aliases `personal`→`.cur`, `company`→`.cursor`.

When profiles are found, `bun run serve` syncs them every 15 minutes.

- **Live hooks**: cache from `afterAgentResponse` (attributed to `.cursor`)
- **sync-usage**: authoritative cache for the date window; tags stub sessions with `.cur` / `.cursor`
- **Backfill alone**: cache stays `0` until you sync-usage or capture via hooks
- Full backfill **keeps** `dash:*` cache rows

## Profile data sources (backfill)

Backfill scans every **existing** `User/globalStorage/state.vscdb` that holds composer/bubble data among:

| Path | Role on this machine |
|------|----------------------|
| `~/Library/Application Support/Cursor/…/state.vscdb` | Main Cursor app (macOS) — usually the large DB |
| `~/.cur/User/globalStorage/state.vscdb` | Separate Cursor-family data root (not a symlink to `~/.cursor`) when present |
| `~/.cursor/User/globalStorage/state.vscdb` | Rarely has composer bubbles; `~/.cursor` is mainly hooks/extensions/projects |
| `~/Library/Application Support/Cur/…/state.vscdb` | Alternate “Cur” app support dir (included only if it has real bubble/header data) |
| `~/.config/Cursor/…/state.vscdb` | Linux Cursor |

Empty or header-less stubs are skipped. Backfill is a **single-pass** read of `bubbleId:%` keys (not one `LIKE` per composer).

## Pricing

Edit [`prices.json`](prices.json) (USD per 1M tokens). Matching is substring on the model name (normalized). Included:

- DeepSeek V4 Flash / Pro
- Grok 4.5
- Claude, GPT, Gemini, Composer, MiniMax

These are **API list-price estimates**, not Cursor invoice line items. Cache tokens use `cache_read` / `cache_write` in `prices.json` (Claude-style 0.1×/1.25× input by default; OpenAI/composer 0.5×; Gemini/Grok 0.25×). After changing prices or syncing usage:

```bash
bun run sync-usage   # refresh cache tokens from dashboard
bun run recompute    # recalculate all session costs
```

## Overview cache

The `/api/overview` payload is cached in the `overview_cache` SQLite table (single row, key
`"default"`). The cache is invalidated whenever new rollups are computed:

- `backfill` (incremental + full) — at the end of the scan
- `sync-usage` — after the per-profile sync loop
- `recompute` — after recomputing all rollups

Between invalidations, the unfiltered overview is served from the cache. The filtered overview
(`?days=` / `?profile=`) always bypasses the cache. If the count of `session_rollups` grows past
the cached snapshot's `source_session_count`, the next request recomputes lazily.

## Hooks

`bun run install-hooks` merges into `~/.cursor/hooks.json` and installs `~/.cursor/hooks/cursor-metrics-hook.sh`.

Events: `sessionStart`, `sessionEnd`, `stop`, `postToolUse`, `postToolUseFailure`, `preCompact`, `afterAgentResponse`.

Metrics DB: `~/.cursor-metrics/metrics.db`

## Privacy

- Reads Cursor `state.vscdb` in read-only mode
- Optional `sync-usage` calls cursor.com with your session cookie (stays on your machine otherwise)
- Stores aggregates + tool names only in `~/.cursor-metrics/`
- Does not send metrics data off-machine (except the authenticated usage pull you opt into)
