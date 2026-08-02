# TDD Implementation Plan: Root-Cause Token Burn Diagnosis

Date: 2026-08-02
Source plan: `docs/token-lens-root-cause-research.md`

## Stack confirmed

- Bun + `bun:sqlite` for backend (`src/`), React + Vite for dashboard (`dashboard/`).
- Existing test conventions: DB / collector / shared tests use the self-check pattern (`tests/*.test.ts`, `bun run tests/...`); dashboard tests use vitest + Testing Library.
- Live tests = boot the real Bun.serve in-process with an in-memory `metrics.db`, seed synthetic rows, hit the actual HTTP endpoints, assert JSON.
- Schema evolution goes through the existing `migrate()` block in `src/db/schema.ts:132`.

---

## Release 1 — "Explain one session"

### 1.1 Schema: turn-level cost columns

**New test (RED):** `tests/schema-turn-cost.test.ts` — open `:memory:`, assert `PRAGMA table_info(turns)` includes `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `total_tokens`, `total_cost_usd`, `model`, `estimated`, `prompt` (all `NOT NULL DEFAULT 0` or nullable per doc) after opening an existing v2 DB pre-seeded with the old shape.

**Implement (GREEN):** extend `src/db/schema.ts:132 migrate()`:
- `ALTER TABLE turns ADD COLUMN …` for the 9 columns, idempotent via `PRAGMA table_info(turns)` membership check (mirrors lines 132-182).
- New `CREATE TABLE IF NOT EXISTS root_cause_events (…)` block.

**New types (GREEN):** add to `src/shared/types.ts`:

```ts
export type RootCauseCategory =
  | "context_accumulation"
  | "tool_output_amplification"
  | "search_thrashing"
  | "retry_amplification"
  | "duplicate_generation"
  | "model_selection"
  | "cache_failure"
  | "reasoning_surprise"
  | "pricing_uncertainty"
  | "data_quality";

export type RootCauseEvent = {
  id: number;
  conversation_id: string;
  generation_id: string | null;
  category: RootCauseCategory;
  confidence: number;          // 0..1
  observed_cost_usd: number | null;
  baseline_cost_usd: number | null;
  evidence_json: string;       // JSON
  recommendation: string;
  created_at: number;
};
```

Extend `SessionDetail.turns` to include `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `total_tokens`, `total_cost_usd`, `model`, `estimated`, `prompt`.

### 1.2 Populate turns from collectors

**Tests (RED):** `tests/turns-population.test.ts` — for each source, seed minimal input, call its ingest function, assert `SELECT * FROM turns WHERE conversation_id = ?` shows non-zero `input_tokens`/`output_tokens`/`total_cost_usd`:

- Cursor: call `parseBubbleKey` + bubble handler extracted into a pure function. Best done by lifting the `upsertTurn + upsertTokenSnapshot` block from `src/collector/backfill.ts:290-321` into `recordTurnFromSnapshot(db, conv, gen, snap, opts)`.
- Claude Code: similar lift from `src/collector/claude-code.ts:291-329`.
- Cursor live hook: `handleCursorHook` from `src/collector/hook-cursor.ts:135-160`.
- Claude Code live hook: `handleClaudeCodeHook` from `src/collector/hook-claude-code.ts:164-184`.
- OpenCode: `src/collector/opencode.ts:213-224`.

**Implement (GREEN):** one helper `recordTurn(db, {conversation_id, generation_id, tokens, cost, model, estimated, prompt, at})` in `src/db/queries.ts`. Each collector calls it after computing cost via `estimateCostUsd`. `recomputeTurn(db, generation_id)` recomputes one turn from its `token_snapshots` rows where `bubble_id` shares its `generation_id`.

### 1.3 Hook `token_snapshots.generation_id` → `turns.generation_id`

**Test (RED):** `tests/snapshot-generation-link.test.ts` — for each collector, assert every written `token_snapshots` row has a matching `turns.generation_id` for the same `conversation_id` and timestamp window.

**Implement (GREEN):** add nullable `generation_id TEXT` column to `token_snapshots` via `migrate()`. Each collector passes `generation_id` through `upsertTokenSnapshot`. `recomputeRollup` (`src/db/queries.ts:204`) joins `token_snapshots` to `turns` on `(conversation_id, generation_id)` so turn cost is always live.

### 1.4 Render turn table + context events in `Detail`

**Test (RED):** `dashboard/src/components/Detail.test.tsx` — extend the existing vitest to render the new `<TurnTable>` and `<ContextEventsTimeline>` subcomponents with a fixture where every turn carries cost. Assert rows render correct input/output/cache/cost values, `~` prefix when `estimated=1`, context usage bar shows max `context_usage_percent`.

**Implement (GREEN):** split `dashboard/src/components/Detail.tsx:159-187` into:

- `<TurnTable turns={…} />` — column model: model, input, output, cache read, cost, context, tools (from `countToolCallsForTurn`), cause (from top root-cause badge).
- `<ContextEventsTimeline events={…} />` — simple bar showing `context_usage_percent` per event.

Reuse existing `<Stat>` / `<BarList>` primitives.

### 1.5 Context-growth detector (Release 1 detector)

**Test (RED):** `tests/detector-context-growth.test.ts`:

- Empty `token_snapshots` → `[]`.
- Monotonically growing input tokens, final turn 4× prior baseline → fires one event with `category="context_accumulation"`, `confidence ≥ 0.8`, `evidence.input_growth_ratio≈4`, `evidence.max_context_percent` populated when `context_events` exist.
- Single-turn session → never fires.
- All turns ≤ 2× baseline → never fires.

**Implement (GREEN):** new file `src/detector/context-growth.ts` exporting `detectContextGrowth(db, conversationId): RootCauseEvent | null`. Pure function on top of `getSessionDetail` rows. Confidence formula: `min(1, (growth_ratio - 1) / 3)`, bumped by +0.1 if `context_usage_percent ≥ 80` observed.

**Wire into rollup:** `src/db/queries.ts:204 recomputeRollup` runs detectors after token aggregation in a single transaction; detectors write `root_cause_events` rows.

### 1.6 Estimated / pricing confidence markers

**Test (RED):** `tests/confidence.test.ts`:

- `getPricingStatus(model, totalCost)` → `"default_price" | "exact" | "estimated"`.
- Unknown model with non-zero tokens → `data_quality` event fires with `evidence.unknown_model`.

**Implement (GREEN):** new file `src/shared/confidence.ts` exporting `getPricingStatus(model)` (uses `normalizeModel` from `src/shared/prices.ts:30` and key-membership). `recordPricingUncertainty(db, conv, model, cost)` writes a `pricing_uncertainty` event when `model` is null/missing or resolves to `prices.default`.

### 1.7 Release 1 verification

```bash
bun run tests/schema-turn-cost.test.ts
bun run tests/turns-population.test.ts
bun run tests/snapshot-generation-link.test.ts
bun run tests/detector-context-growth.test.ts
bun run tests/confidence.test.ts
bun test tests/overview-cache.test.ts tests/tools-registry.test.ts tests/cli-export.test.ts
cd dashboard && bun run vitest --run
```

Live test: `tests/live/release1.test.ts` — boot `startServer(db, {port: 0})`, seed two sessions, `GET /api/sessions/:id`, assert `turns[i].total_cost_usd > 0` and `root_cause_events` returns the context-growth hit.

---

## Release 2 — "Explain recurring waste"

### 2.1 Tool-to-turn association

**Test (RED):** `tests/tool-turn-attribution.test.ts`:

- A `tool_calls` row with non-null `generation_id` aggregates to that turn.
- A `tool_calls` row with null `generation_id` (legacy backfill) falls back to "since previous assistant response" — i.e. nearest preceding `turns.ended_at` per session.

**Implement (GREEN):** `src/db/queries.ts` add `listToolCallsForTurn(db, conversation_id, generation_id)` and `countToolCallsForTurn`. Update `getSessionDetail` to include `tools_by_turn: Array<{generation_id, tools: Array<{name, count, failures}>}>`.

### 2.2 Search/read thrashing detector

**Test (RED):** `tests/detector-search-thrashing.test.ts`:

- 25 grep calls in 5 turns with no LeanKG use → fires `search_thrashing`, `confidence ≥ 0.85`, evidence includes `search_per_turn`, `leankg_per_turn=0`.
- Same pattern but ≥ 1 LeanKG call → no event.
- Same pattern but `file_reads > 30` with `reads/turn > 6` → fires `tool_output_amplification` instead.

**Implement (GREEN):** `src/detector/search-thrashing.ts`. Reads `tool_calls` grouped by `tool_name` (`isSearchTool`/`isReadTool` from `src/shared/tools.ts:17,21`). Run inside `recomputeRollup`.

### 2.3 Retry / duplicate detector

**Test (RED):** `tests/detector-retry.test.ts`:

- Same `generation_id` appears in `tool_calls` ≥ 3 times within 60s of a `success=0` row → fires `retry_amplification`, evidence includes `retry_count`, `first_error_tool`.
- Two adjacent turns with `prompt` Jaccard ≥ 0.9 and tool-set identical → fires `duplicate_generation`, confidence 0.7 (lower because prompt hashing is default).

**Implement (GREEN):** `src/detector/retry.ts` — pure SQL window functions; same `generation_id` count + 60s window. `src/detector/duplicate.ts` — hashes prompts with `Bun.hash` only when `prompt` is present (default off for privacy).

### 2.4 Model-selection detector

**Test (RED):** `tests/detector-model-selection.test.ts`:

- Session uses `opus` model for ≥ 80% of cost but other sessions in same window do the same task on `sonnet` with similar turn counts → fires `model_selection`. (Use a fixture with two sessions, one opus, one sonnet, comparable cost-per-turn.)
- Session uses unknown model (`"(unknown)"`) → fires `data_quality`.

**Implement (GREEN):** `src/detector/model-selection.ts` — compute median cost/turn for the model's profile, compare to other models on the same window; fire if model ≥ 3× median.

### 2.5 Cache-failure detector

**Test (RED):** `tests/detector-cache.test.ts`:

- Input tokens ≥ 20k and `cache_reads / (input_tokens + cache_reads) < 0.1` → fires `cache_failure`, evidence includes `cache_hit_rate`, `cache_savings_usd` (computed vs. worst-case full input re-billing).
- Hit rate ≥ 0.6 → never fires.

**Implement (GREEN):** `src/detector/cache.ts`. `cache_savings_usd` formula reuses `cacheRates` from `src/shared/prices.ts:46`.

### 2.6 Reasoning surprise + cost-driver API

**Tests (RED):**

- `tests/detector-reasoning.test.ts` — when output_tokens > input_tokens × 1.5 and model name contains `reasoning|thinking|o1|o3`, fires `reasoning_surprise` with `evidence.reasoning_share`.
- `tests/api-cost-drivers.test.ts` — boot live server, seed two model rows, hit `GET /api/cost-drivers?days=7`, assert sorted by `total_cost_usd DESC`.

**Implement (GREEN):** `src/detector/reasoning.ts`. `src/server/api.ts:88` add `/api/cost-drivers?by=tool|model|workspace|root_cause` returning `Array<{key, sessions, total_cost_usd, root_cause?: string}>` (root-cause join uses `SUM(cost_observed)` aggregation over `root_cause_events`).

### 2.7 CLI root-cause report

**Test (RED):** `tests/cli-root-causes.test.ts` — exec `bun src/analyze.ts --json --root-causes` against a seeded DB; assert JSON array, each item has `category`, `session_id`, `turn_id?`, `observed_cost_usd`, `baseline_cost_usd`, `evidence`, `confidence`, `recommendation`. Verify `--since 7 --root-causes` filters by `started_at`.

**Implement (GREEN):** extend `src/analyze.ts:102` with `H2("Root-cause incidents")` block reading `root_cause_events` joined to `session_rollups`. Add `--json` (single-line JSON dump to stdout, no markdown) and `--root-causes` (render only this section) flags.

### 2.8 Release 2 verification

Same `bun run tests/...` plus `tests/live/release2.test.ts` (server boots, hits `/api/cost-drivers?by=root_cause`).

---

## Release 3 — "Prevent recurrence"

### 3.1 Baseline + anomaly guardrails

**Tests (RED):**

- `tests/baseline.test.ts` — median + P95 over a 14-day window of the same workspace; single session above P95 + 2σ fires `anomaly` event in `root_cause_events` with `category="data_quality"` and `evidence.zscore`.
- `tests/budget.test.ts` — daily cost > workspace budget → `budget_exceeded` event. Budgets read from `~/.token-lens/budgets.json` (new config; covered by unit test that mocks fs).

**Implement (GREEN):** `src/detector/baseline.ts` (median/MAD on session_rollups by workspace), `src/detector/budget.ts` (read JSON, write events when exceeded). Detector results write to `root_cause_events` with `category="data_quality"` + `evidence.budget_usd`/`evidence.zscore` to avoid an enum explosion.

### 3.2 Cache + downgrade suggestions

**Tests (RED):** `tests/recommendations.test.ts` — given a cache_failure event, `recommendCacheFixes(event)` returns `["Stabilize tool definitions", "Place static system prompt first", …]`. `tests/recommendations-downgrade.test.ts` — model_selection event returns `["Route classification to cheaper model", …]`.

**Implement (GREEN):** `src/recommendations/cache.ts`, `src/recommendations/downgrade.ts`. Each detector returns a `recommendation` string already (per the doc); the helper maps detector evidence → bulleted list for dashboard display.

### 3.3 Dashboard guards

**Tests (RED):** extend `dashboard/src/components/Overview.test.tsx` (new vitest) — mock `api.anomalies()` (new endpoint returning top 5 events) and assert anomaly banner renders when count > 0.

**Implement (GREEN):** `/api/anomalies` in `src/server/api.ts` returning top-N rows from `root_cause_events` ordered by `confidence DESC, observed_cost_usd DESC`. New `<AnomalyBanner />` component on Overview page.

### 3.4 CI cost-regression check

**Test (RED):** `tests/cli-cost-check.test.ts` — given a fixture DB with a known baseline and a fixture "current" run with cost 2× baseline, `bun src/analyze.ts --check --baseline <file> --fail-over 0.5` exits 1 with a clear message.

**Implement (GREEN):** new flag in `src/analyze.ts`; baseline file is JSON `{by_workspace: {ws: median_cost_usd}}`.

### 3.5 Release 3 verification

`bun run tests/...` plus live: `tests/live/release3.test.ts` hits `/api/anomalies` and `analyze.ts --check` end-to-end.

---

## Release 4 — "Ecosystem integration"

### 4.1 Generic span import

**Tests (RED):** `tests/import-otel.test.ts` — given a JSONL file of OpenTelemetry GenAI spans (synthesized in the test fixture: 5 spans across 2 sessions with `gen_ai.usage.input_tokens` etc.), `importOtel(db, path)` populates `sessions`, `turns`, `token_snapshots`, `tool_calls`, `context_events` correctly and skips unknown attributes. Same shape for `tests/import-langfuse.test.ts`, `tests/import-helicone.test.ts`, `tests/import-phoenix.test.ts`.

**Implement (GREEN):**

- `src/import/otel.ts` — maps `gen_ai.conversation.id`, `gen_ai.response.id`, `gen_ai.usage.{input,output,cache_read,cache_write}_tokens`, `gen_ai.request.model`, `tool.{name,status}`.
- `src/import/langfuse.ts`, `src/import/helicone.ts`, `src/import/phoenix.ts` — adapter pattern: each exports `normalize(span): {session_id, generation_id, tokens, model, cost_known?}` then shares `writeImportedRows(db, normalized)`.

All importers share `src/import/writer.ts` (writes sessions + turns + token snapshots + tool calls in one transaction).

### 4.2 Provider invoice reconciliation

**Tests (RED):** `tests/reconcile.test.ts` — given local `token_snapshots` (sum = 100k input) and a Cursor invoice JSON (110k input), `reconcile(db, invoicePath)` writes a `data_quality` event with `evidence.local_input`, `evidence.invoice_input`, `evidence.delta_pct`.

**Implement (GREEN):** `src/reconcile/cursor-invoice.ts` reads Cursor usage JSON (mocked shape in test), joins by `model` + day, emits events.

### 4.3 CLI subcommands

**Tests (RED):** `tests/cli-import.test.ts`, `tests/cli-reconcile.test.ts` — exec `bun src/cli.ts import otel <file>`, `reconcile cursor <file>`, assert row counts and that existing rollups are recomputed.

**Implement (GREEN):** extend `src/cli.ts` with `import <otel|langfuse|helicone|phoenix> <file>` and `reconcile cursor <file>`. Update `usage()` (lines 22-47).

### 4.4 Release 4 verification

`bun run tests/...` plus live: `tests/live/release4.test.ts` runs all four importers against fixture files through the CLI binary.

---

## Privacy & correctness guardrails (across all releases)

Add to `src/shared/confidence.ts`:

- `confidence ∈ [0, 1]` invariant.
- Heuristic tool attribution never contributes to `total_cost_usd`; only to a separate `attributed_tool_cost_usd` column on `turns` (nullable).

**Tests:** `tests/guardrails.test.ts`:

- Confidence clamped to [0,1].
- A turn with only heuristic tool attribution has `total_cost_usd` independent of those tools.
- Prompts default to `null` in `token_snapshots` for collectors that opt out (config knob `TOKEN_LENS_STORE_PROMPTS=0`).

**Implement:** env-flag check in `src/collector/*` writer helpers; skip writing `prompt` field when set.

---

## Test layout summary

```
tests/
  schema-turn-cost.test.ts          (1.1)
  turns-population.test.ts          (1.2)
  snapshot-generation-link.test.ts  (1.3)
  detector-context-growth.test.ts   (1.5)
  confidence.test.ts                (1.6)
  tool-turn-attribution.test.ts     (2.1)
  detector-search-thrashing.test.ts (2.2)
  detector-retry.test.ts            (2.3)
  detector-model-selection.test.ts  (2.4)
  detector-cache.test.ts            (2.5)
  detector-reasoning.test.ts        (2.6)
  api-cost-drivers.test.ts          (2.6)
  cli-root-causes.test.ts           (2.7)
  baseline.test.ts                  (3.1)
  budget.test.ts                    (3.1)
  recommendations.test.ts           (3.2)
  recommendations-downgrade.test.ts (3.2)
  cli-cost-check.test.ts            (3.4)
  import-otel.test.ts               (4.1)
  import-langfuse.test.ts           (4.1)
  import-helicone.test.ts           (4.1)
  import-phoenix.test.ts            (4.1)
  reconcile.test.ts                 (4.2)
  cli-import.test.ts                (4.3)
  cli-reconcile.test.ts             (4.3)
  guardrails.test.ts                (Privacy)
  live/
    release1.test.ts                (boots startServer)
    release2.test.ts
    release3.test.ts
    release4.test.ts

dashboard/src/components/
  Detail.test.tsx                   (extend existing)
  Sessions.test.tsx                 (extend existing)
  Overview.test.tsx                 (new — anomaly banner)
  TurnTable.test.tsx                (new)
  ContextEventsTimeline.test.tsx    (new)
```

## Source layout summary

```
src/
  db/
    schema.ts                       (extend migrate())
    queries.ts                      (add recomputeTurn, listToolCallsForTurn)
    overview-cache.ts               (no change)
    root-causes.ts                  (new — list/write helpers)
  shared/
    types.ts                        (extend SessionDetail.turns)
    confidence.ts                   (new)
    tools.ts                        (no change unless detector adds a pattern)
    prices.ts                       (no change)
  detector/
    context-growth.ts               (new)
    search-thrashing.ts             (new)
    retry.ts                        (new)
    duplicate.ts                    (new)
    model-selection.ts              (new)
    cache.ts                        (new)
    reasoning.ts                    (new)
    baseline.ts                     (new)
    budget.ts                       (new)
  recommendations/
    cache.ts                        (new)
    downgrade.ts                    (new)
  import/
    writer.ts                       (new)
    otel.ts                         (new)
    langfuse.ts                     (new)
    helicone.ts                     (new)
    phoenix.ts                      (new)
  reconcile/
    cursor-invoice.ts               (new)
  server/
    api.ts                          (add /api/cost-drivers, /api/anomalies)
  analyze.ts                        (add --json --root-causes --check)
  cli.ts                            (add import + reconcile subcommands)
dashboard/src/components/
  Detail.tsx                        (split out TurnTable, ContextEventsTimeline)
  Overview.tsx                      (add AnomalyBanner)
  AnomalyBanner.tsx                 (new)
  TurnTable.tsx                     (new)
  ContextEventsTimeline.tsx         (new)
```

---

## Sequencing & checkpoints

Each release ends with a green run of:

```bash
bun run tests/schema-turn-cost.test.ts \
  && bun run tests/turns-population.test.ts \
  && bun run tests/snapshot-generation-link.test.ts \
  && bun run tests/detector-context-growth.test.ts \
  && bun run tests/confidence.test.ts \
  && bun test tests/overview-cache.test.ts tests/tools-registry.test.ts tests/cli-export.test.ts \
  && cd dashboard && bun run vitest --run \
  && bun run tests/live/release1.test.ts
```

Subsequent releases add their slice to the same one-liner. Each release is one PR; the merge gate is the green one-liner above.
