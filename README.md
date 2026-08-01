<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/hero-dark.svg">
  <img alt="Token Lens - Local AI Coding Session Dashboard" src=".github/hero-light.svg">
</picture>

<p align="center">
  <b>See exactly where your AI coding budget goes — turns, tokens, and cost per session.</b>
</p>

<p align="center">
  <a href="#quick-start"><strong>Quick start</strong></a> ·
  <a href="#features"><strong>Features</strong></a> ·
  <a href="#dashboard"><strong>Dashboard</strong></a> ·
  <a href="#cli"><strong>CLI</strong></a> ·
  <a href="#supported-tools"><strong>Supported tools</strong></a> ·
  <a href="#contributing"><strong>Contributing</strong></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/bun-≥1.0-f9f9f9?style=flat&logo=bun" alt="Bun">
  <img src="https://img.shields.io/github/license/FreePeak/token-lens" alt="MIT">
  <img src="https://img.shields.io/badge/PRs-welcome-brightgreen" alt="PRs welcome">
  <img src="https://img.shields.io/github/stars/FreePeak/token-lens" alt="GitHub stars">
  <img src="https://img.shields.io/github/v/release/FreePeak/token-lens" alt="Latest release">
</p>

---

## What is Token Lens?

**Token Lens** is a local-first dashboard that turns your AI coding sessions into transparent cost and usage data. It reads from Cursor's local state database, captures live hooks, and estimates spending based on each model's public API pricing.

No data leaves your machine. Nothing is uploaded. The privacy guarantee is baked into the architecture.

If you use AI coding tools daily, you've probably asked: *"How many tokens did that session burn?"* or *"Which model is driving up my bill?"* Token Lens answers those questions — for free, offline, and instantly.

## Quick start

```bash
# Requires Bun ≥1.0 — install: https://bun.sh
git clone https://github.com/FreePeak/token-lens.git
cd token-lens

# Install dependencies
bun install
cd dashboard && bun install && cd ..

# Import historical sessions from Cursor
bun run backfill

# Wire live capture hooks (restart Cursor after this)
bun run install-hooks

# Build dashboard UI + start server
cd dashboard && bun run build && cd ..
bun run serve
```

Open [http://localhost:3847](http://localhost:3847). That's it.

#### Dev mode (HMR + API auto-restart)

For iterating on the UI, `bun run dev` (or `make dev`) runs both processes in parallel: the API with `bun --watch` and Vite with HMR. Open `http://localhost:5173` — Vite proxies `/api` to the API on `:3847`. Edits under `dashboard/src/` hot-reload; edits under `src/` restart the API.

### What you'll see right away

- **Overview** — total sessions, turns, token burn, and estimated cost
- **Sessions** — per-conversation breakdown with model, cost, tokens, and duration
- **Drivers** — top tools, models, and cost-per-turn analysis
- **Detail view** — drill into any session for token timeline, context pressure, and tool usage

## Features

| | Feature | How it works |
|---|---|---|
| 📊 | **Local dashboard** | SQLite + Bun server, serves a React UI on `localhost:3847` |
| 🔌 | **Multi-tool registry** | Cursor + Claude Code + OpenCode — add a tool in one file |
| ⚡ | **Live capture** | Cursor hooks + Claude Code `settings.json` hooks stream events in real time |
| 📜 | **Historical backfill** | Scans `state.vscdb` for all past sessions — incremental or full |
| 💰 | **Cost estimates** | Model pricing from `prices.json` (DeepSeek, Grok, Claude, GPT, Gemini, and more) |
| 🧠 | **Prompt cache tracking** | Syncs cache read/write tokens from Cursor's dashboard API using your local login |
| 📈 | **Token waste analysis** | CLI report generator — top spenders, context bloat, cache misses, search-vs-graph patterns |
| 🔒 | **100% local** | No telemetry, no uploads, no accounts. Reads `state.vscdb` read-only. |
| 🕐 | **Auto-sync** | Backfills and syncs usage every 15 minutes when the server is running |
| 🖥️ | **CLI tools** | Export to CSV, pipe analysis to Claude, install launchd cron |

## Dashboard

The dashboard auto-detects Cursor profiles (`.cursor`, `.cur`) and lets you filter by time range and profile.

### Overview

Aggregate metrics, cost by model, and top tools by call volume.

![Token Lens Overview](.github/screenshot-overview.png)

### Sessions

Every conversation with model, cost, tokens, cache reads, and duration. Sortable by date, cost, or duration.

![Token Lens Sessions](.github/screenshot-sessions.png)

### Drivers

Top cost drivers grouped by tool, model, or workspace — efficiency scores and call distribution.

![Token Lens Drivers — by tool](.github/screenshot-drivers-tool.png)
![Token Lens Drivers — by model](.github/screenshot-drivers-model.png)

### Detail

Drill into any session for token timeline, context pressure, per-turn tool usage, and the first user prompt.

![Token Lens Session Detail](.github/screenshot-session-detail.png)

## CLI

```text
token-lens — local AI coding session metrics

Usage:
  token-lens backfill [--incremental|--full] [--tool cursor|claude-code|opencode]
  token-lens sync-usage [--days N] [--profile .cur|.cursor|all]
  token-lens recompute
  token-lens serve [--port N] [--no-backfill]
  token-lens install-hooks [--tool ID]
  token-lens hook                              (internal)
  token-lens export [--table sessions|session_rollups]
  token-lens cron install|uninstall|status
  token-lens analyze [--since DAYS] [--sessions N] [--profile NAME]
  token-lens analyze:claude
  token-lens analyze:html
  token-lens analyze:compact
```

Run `bun run <script>` or `make <target>` for the equivalent Makefile targets.

## Supported tools

| Tool | Status | Backfill | Live hooks | Usage sync |
|---|---|---|---|---|
| **Cursor** | ✅ Complete | ✅ | ✅ | ✅ (dashboard API) |
| **Claude Code** | ✅ Complete | ✅ | ✅ (settings.json) | — (tokens from JSONL) |
| **OpenCode** | ✅ Complete | ✅ (sqlite) | 🟡 Use backfill | — (tokens from session row) |

Adding a tool = create `src/tools/<id>.ts` implementing the `Tool` interface and register it. The CLI, dashboard, and cron pick it up automatically.

### What we read from each tool

- **Cursor** — SQLite `state.vscdb` (`bubbleId:*` KV rows + `composerHeaders`) + `~/.cursor/hooks.json` + the dashboard `/api/.../get-filtered-usage-events` API for cache tokens.
- **Claude Code** — JSONL files at `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` (full message log with usage + tool_use blocks) + `~/.claude/settings.json` for live hooks.
- **OpenCode** — `~/.local/share/opencode/opencode.db` (`session` + `message` + `part` tables; tokens & cost are pre-aggregated per session, `part.type='tool'` rows for tool calls).

To scope the backfill to one tool:

```bash
bun run backfill --tool claude-code     # only Claude Code JSONL
bun run backfill --tool opencode        # only OpenCode sqlite
bun run backfill --tool cursor          # only Cursor state.vscdb
```

The dashboard's profile filter automatically picks up the new profiles (`.claude`, `.opencode`) alongside `.cursor` / `.cur`.

## Pricing data

Token Lens ships with a `prices.json` covering popular models:

- DeepSeek V4 Flash / Pro
- Grok 4.5
- Claude, GPT, Gemini, GPT Composer, MiniMax

Prices are **API list-price estimates** in USD per 1M tokens — not Cursor invoice line items. Cache tokens use model-specific rates (Claude: 0.1× read / 1.25× write, OpenAI: 0.5×, Gemini/Grok: 0.25×).

Update pricing at any time:

```bash
bun run prices:fetch       # print latest OpenRouter prices
bun run prices:sync        # merge into prices.json
bun run sync-usage         # refresh cache tokens
bun run recompute          # recalculate all session costs
```

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                    Token Lens                         │
│                                                       │
│  ~/.token-lens/                                       │
│   └── metrics.db          SQLite (sessions, rollups)  │
│                                                       │
│  Cursor state.vscdb       Read-only source DB         │
│  Cursor hooks.json        Live capture via hooks      │
│  Cursor dashboard API     Cache token sync            │
│                                                       │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────┐    │
│  │ backfill │  │  hooks   │  │  sync-usage      │    │
│  │ scanner  │  │ handler  │  │  (dashboard API)  │    │
│  └────┬─────┘  └────┬─────┘  └───────┬──────────┘    │
│       └──────────────┴───────────────┘                │
│                              ▼                         │
│                     ┌──────────────┐                   │
│                     │   SQLite DB  │                   │
│                     └──────┬───────┘                   │
│                            ▼                            │
│  ┌──────────┐  ┌─────────────┐  ┌────────────────┐    │
│  │  Bun API │  │  Dashboard  │  │  analyze/report │    │
│  │  server  │  │  (React)    │  │  (CLI)          │    │
│  └──────────┘  └─────────────┘  └────────────────┘    │
└─────────────────────────────────────────────────────────┘
```

## Privacy

Token Lens is designed around a hard privacy boundary:

- **Reads Cursor `state.vscdb` in read-only mode** — never writes to it
- **Optional `sync-usage`** calls cursor.com using **your local session cookie** — only to fetch cache-token data that isn't stored locally
- **Stores only aggregates + tool names** in `~/.token-lens/metrics.db`
- **No telemetry, no analytics, no tracking** — the project itself has zero analytics code
- **No accounts, no sign-up, no cloud** — everything runs on `localhost:3847`

## Roadmap

- [ ] Claude Code live usage sync (no separate API; JSONL has everything)
- [ ] OpenCode live hooks (no plugin protocol today; backfill covers it)
- [ ] Export to shareable reports
- [ ] Plugin system for custom cost models
- [ ] Alerts (weekly budget report, unusual spend detection)

*Open an issue to suggest something.*

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) to get started.

- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Security policy](SECURITY.md)
- [Bug reports](https://github.com/FreePeak/token-lens/issues/new?template=bug_report.md)
- [Feature requests](https://github.com/FreePeak/token-lens/issues/new?template=feature_request.md)

## License

MIT © [Token Lens Contributors](LICENSE)

---

<p align="center">
  <sub>Built for developers who want to understand their AI tooling costs. No strings attached. No cloud. No catch.</sub>
</p>
