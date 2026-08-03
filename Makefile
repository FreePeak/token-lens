# token-lens — Makefile
#
# Mirrors every script in package.json plus every subcommand exposed by
# src/cli.ts. Use `make help` to list targets. Override Bun with
# `BUN=/path/to/bun make <target>`.
#
# Mapping:
#   make backfill           ->  bun run src/cli.ts backfill
#   make backfill-incremental -> bun run src/cli.ts backfill --incremental
#   make cron-install       ->  bun run src/cli.ts cron install
#   make dashboard-dev      ->  cd dashboard && bun run dev
#   ... see `make help`

BUN ?= bun
CLI = $(BUN) run src/cli.ts

.PHONY: help \
        backfill backfill-incremental sync-usage recompute export \
        cron-install cron-uninstall cron-status \
        serve hook install-hooks \
        dashboard-install dashboard-dev dashboard-build \
        analyze analyze-claude analyze-html analyze-compact \
        prices-fetch prices-sync \
        dev test reprofile reprofile-apply

help: ## show this help
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z_-]+:.*?## / {printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

# --- collector -------------------------------------------------------

backfill: ## full backfill (defaults to incremental)
	$(CLI) backfill

backfill-incremental: ## incremental backfill (cron uses this)
	$(CLI) backfill --incremental

sync-usage: ## sync usage from local state DBs (--days N, --profile NAME)
	$(CLI) sync-usage

recompute: ## recalculate session rollups
	$(CLI) recompute

export: ## export table to CSV (TABLE=sessions|session_rollups)
	$(CLI) export $(TABLE)

# --- cron (launchd) --------------------------------------------------

cron-install: ## install 15-min launchd backfill cron
	$(CLI) cron install

cron-uninstall: ## remove launchd plist
	$(CLI) cron uninstall

cron-status: ## show cron job status
	$(CLI) cron status

# --- server / hooks --------------------------------------------------

serve: ## run API + dashboard (--port N, --no-backfill)
	$(CLI) serve

hook: ## run a single hook invocation (reads JSON from stdin)
	$(CLI) hook

install-hooks: ## wire Cursor hooks at ~/.cursor/hooks.json (token-lens-hook.sh)
	$(CLI) install-hooks

# --- dashboard (cd into dashboard/) ----------------------------------

dashboard-install: ## install dashboard deps
	cd dashboard && $(BUN) install

dashboard-dev: ## run dashboard dev server
	cd dashboard && $(BUN) run dev

dashboard-build: ## build dashboard for serve to serve
	cd dashboard && $(BUN) run build

# --- convenience / extras --------------------------------------------

analyze: ## run token waste analysis report to stdout (--since DAYS, --sessions N, --profile NAME)
	$(BUN) run src/analyze.ts

analyze-claude: ## pipe token waste analysis to claude for root-cause investigation
	$(BUN) run src/analyze.ts --claude

analyze-html: ## export token waste analysis to HTML file (--since DAYS, --sessions N, --profile NAME, FILE=out.html)
	$(BUN) run src/analyze.ts --html $(FILE)

analyze-compact: ## run compact token waste analysis (for piping to claude)
	$(BUN) run src/analyze.ts --compact

dev: ## run API on http://localhost:5173 (serves API + built dashboard)
	$(BUN) run scripts/dev.ts

test: ## run overview-cache self-check
	$(BUN) run tests/overview-cache.test.ts

reprofile: ## reprofile dry-run
	$(BUN) run scripts/reprofile.ts

reprofile-apply: ## reprofile and mutate metrics.db
	$(BUN) run scripts/reprofile.ts --apply

# --- prices ------------------------------------------------------------

prices-fetch: ## print latest OpenRouter model prices as Markdown table
	$(BUN) run scripts/fetch-prices.ts

prices-sync: ## merge latest OpenRouter prices into prices.json
	$(BUN) run scripts/fetch-prices.ts --apply
