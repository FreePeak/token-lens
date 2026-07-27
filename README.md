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
| Tokens | — | `cursorDiskKV` bubble `tokenCount` |
| Cost | Estimated via `prices.json` | Same |
| Duration | `sessionStart` → `sessionEnd` | Header timestamps |

Re-run `bun run backfill` periodically to refresh token totals from Cursor's DB (hooks do not receive billed token counts).

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

These are **API list-price estimates**, not Cursor invoice line items.

## Hooks

`bun run install-hooks` merges into `~/.cursor/hooks.json` and installs `~/.cursor/hooks/cursor-metrics-hook.sh`.

Events: `sessionStart`, `sessionEnd`, `stop`, `postToolUse`, `postToolUseFailure`, `preCompact`, `afterAgentResponse`.

Metrics DB: `~/.cursor-metrics/metrics.db`

## Privacy

- Reads Cursor `state.vscdb` in read-only mode
- Stores aggregates + tool names only in `~/.cursor-metrics/`
- Does not send data off-machine
