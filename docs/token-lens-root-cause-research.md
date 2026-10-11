# Token Lens: Root-Cause Token Burn Research

Date: 2026-08-02

## Executive summary

Token Lens currently answers **where tokens went**. It does not reliably answer **what caused the burn**.

Product position: **local-first causal debugger for AI coding spend**.

Primary user question:

> This session cost 4× normal. Which turn, tool, prompt growth, retry, model, cache failure, or context event caused it?

Core diagnostic chain:

```text
Cost anomaly
  ↓
Affected session / workspace / model
  ↓
Affected turn
  ↓
Preceding tools and context state
  ↓
Likely mechanism
  ↓
Evidence and confidence
  ↓
Recommended fix
```

## Current architecture and gaps

Token Lens uses a Bun + SQLite local pipeline. It ingests Cursor, Claude Code, and OpenCode data into `~/.token-lens/metrics.db`, serves a small HTTP API, and exposes a React dashboard.

### Evidence-backed gaps

| Gap | Evidence | User impact |
|---|---|---|
| Turns lack token and cost fields | `src/db/schema.ts:48-55` | Cannot identify exact expensive turn without client-side reconstruction |
| Token snapshots lack stable turn relationship | `src/db/schema.ts:70-83`, `dashboard/src/components/Detail.tsx:37-60` | Turn grouping is inferred from order and prompt presence |
| Tool drivers report zero token/cost values | `src/db/queries.ts:483-514` | User sees tool volume, not tool-associated burn |
| Context events are stored but not rendered | `src/db/schema.ts:87-94`, `dashboard/src/components/Detail.tsx:18-190` | Context pressure and compaction remain hidden |
| Search classification uses hard-coded names | `src/shared/tools.ts:7` | New search or MCP tools disappear from waste analysis |
| Unknown models silently use default pricing | `src/shared/prices.ts:72-84` | Guessed costs look authoritative |
| Estimated tokens mark sessions broadly | `src/collector/backfill.ts:261-285` | User cannot see which values are estimates |
| No time-series or comparison dashboard | `dashboard/src/App.tsx:19-128` | Spend changes have no baseline context |
| No budget or anomaly guardrails | `README.md:232-238` | Detection happens after burn |

## Root-cause taxonomy

### 1. Context accumulation

Signals:

- Input tokens rise monotonically across turns.
- Latest input tokens exceed session baseline by a large ratio.
- Context usage approaches the model limit.
- Compaction occurs before another large request.

Likely fixes:

- Shorten history.
- Compact earlier.
- Reduce tool output.
- Start a fresh session at a context threshold.

### 2. Tool-output amplification

Signals:

- Large tool response precedes a sharp input-token increase.
- Same verbose tool repeats across turns.
- Tool payload becomes part of subsequent context.

Likely fixes:

- Truncate output.
- Return summaries.
- Filter files before context insertion.

### 3. Search/read thrashing

Signals:

- Repeated searches or reads.
- Low unique-file progress.
- Search volume exceeds expected work for session type.
- No indexed search usage.

Likely fixes:

- Use indexed search.
- Batch reads.
- Narrow search scope.
- Detect and suppress equivalent queries.

### 4. Retry amplification

Signals:

- Same logical request repeats after 429, timeout, provider error, or tool failure.
- Full context is resent on each attempt.
- Error count and input tokens rise together.

Likely fixes:

- Cap retries.
- Use exponential backoff.
- Retry only transient errors.
- Reduce context before retry.

### 5. Duplicate generation or regeneration

Signals:

- Adjacent turns have near-identical prompt and tool sequence.
- No meaningful state change separates generations.

Likely fixes:

- Preserve failed state.
- Repair tool errors instead of regenerating.
- Improve stop conditions.

### 6. Model-selection waste

Signals:

- High-cost model handles routine work.
- Equivalent tasks succeed on cheaper model.
- Cost rises without quality or failure-rate improvement.

Likely fixes:

- Route classification and extraction to cheaper models.
- Reserve frontier models for complex tasks.
- Add explicit fallback policy.

### 7. Cache failure

Track separately:

- Uncached input tokens.
- Cache creation tokens.
- Cache read tokens.
- Cache hit rate.
- Cache savings in USD.

Signals:

- Large repeated static prefix has low cache hit rate.
- Prompt version changes correlate with cache misses.
- Dynamic values appear before reusable static content.

Likely fixes:

- Place static system prompt first.
- Stabilize tool definitions.
- Use explicit cache breakpoints.
- Track prompt version.

### 8. Reasoning-token surprise

Signals:

- Reasoning tokens dominate output cost.
- Reasoning share rises for routine tasks.

Likely fixes:

- Lower reasoning effort.
- Use non-reasoning model for routine work.
- Simplify task decomposition.

### 9. Pricing and data-quality uncertainty

Signals:

- Unknown model.
- Default price fallback.
- Estimated token count.
- Missing cache data.
- Provider-billed count differs from locally consumed count.

Likely fixes:

- Update price book.
- Re-import provider usage.
- Mark confidence clearly.
- Separate exact and estimated totals.

## Recommended data model

### First migration: make turns first-class cost units

Add to `turns`:

```sql
ALTER TABLE turns ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE turns ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE turns ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE turns ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE turns ADD COLUMN total_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE turns ADD COLUMN total_cost_usd REAL NOT NULL DEFAULT 0;
ALTER TABLE turns ADD COLUMN model TEXT;
ALTER TABLE turns ADD COLUMN estimated INTEGER NOT NULL DEFAULT 0;
ALTER TABLE turns ADD COLUMN prompt TEXT;
```

Use stable relationship:

```text
token_snapshots.generation_id → turns.generation_id
```

Populate from:

- Cursor: `src/collector/backfill.ts:478-625`
- Claude Code: `src/collector/claude-code.ts:291-329`
- Cursor live hook: `src/collector/hook-cursor.ts:135-160`
- Claude Code live hook: `src/collector/hook-claude-code.ts:164-184`
- OpenCode: `src/collector/opencode.ts:213-224`

### Root-cause events

```sql
CREATE TABLE IF NOT EXISTS root_cause_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  generation_id TEXT,
  category TEXT NOT NULL,
  confidence REAL NOT NULL,
  observed_cost_usd REAL,
  baseline_cost_usd REAL,
  evidence_json TEXT NOT NULL,
  recommendation TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
```

Controlled categories:

```text
context_accumulation
tool_output_amplification
search_thrashing
retry_amplification
duplicate_generation
model_selection
cache_failure
reasoning_surprise
pricing_uncertainty
data_quality
```

Keep evidence flexible in JSON. Keep category values controlled in application code.

## Attribution rules

### Exact attribution

Use shared `generation_id`:

```text
tool call → generation_id → turn cost
```

### Heuristic attribution

When IDs do not match, use:

- Tools since previous assistant response.
- Nearest preceding tool timestamp.
- Matching session and turn boundaries.

Display confidence:

```text
high | medium | low
```

Never show heuristic attribution as exact billing.

## Dashboard plan

### Overview

Add:

1. Cost trend with request-volume overlay.
2. P50, P95, and P99 cost per session.
3. Input/output token ratio trend.
4. Cache hit rate and dollars saved.
5. Exact versus estimated token percentage.
6. Root-cause categories by cost.
7. Anomaly list.

Useful diagnostic ratio:

```text
P99 session cost / P50 session cost
```

Large ratio exposes runaway sessions hidden by averages.

### Sessions

Add columns:

- Root-cause badge.
- Cost versus baseline.
- Largest turn cost.
- Context peak.
- Retry count.
- Cache hit rate.
- Data confidence.

### Session detail

Show turn table:

| Turn | Model | Input | Output | Cache read | Cost | Context | Tools | Cause |
|---|---|---:|---:|---:|---:|---:|---:|---|
| 8 | opus | 31.2k | 4.1k | 0 | $0.78 | 91% | 14 | context growth |

Evidence panel example:

```text
Turn 8 followed 12 file reads.
Input increased 3.6× over prior turn.
Cache read dropped to zero.
```

Render `context_events`; current detail view receives context events but does not display them.

### Drivers

Separate:

- Tools by call count.
- Tools by associated token cost.
- Models by cost.
- Workspaces by cost.
- Root causes by cost.

## CLI plan

Extend `src/analyze.ts:102-728` with a root-cause section:

```text
Root-cause incidents
- category
- session
- turn
- evidence
- confidence
- recommendation
```

Add machine-readable mode:

```bash
token-lens analyze --json
token-lens analyze --since 7 --root-causes
```

Example:

```json
{
  "type": "context_accumulation",
  "session_id": "…",
  "turn_id": "…",
  "observed_cost_usd": 1.82,
  "baseline_cost_usd": 0.44,
  "evidence": {
    "input_growth_ratio": 4.8,
    "context_peak_percent": 92,
    "tool_calls_before_turn": 31
  },
  "confidence": 0.91
}
```

Use one detector engine for CLI and API.

## Delivery sequence

### Release 1: explain one session

- Materialize turn-level token cost.
- Render turn table.
- Render context events.
- Add context-growth detector.
- Add estimated and pricing confidence.
- Add rollup and detector tests.

Success condition:

> User identifies one evidence-backed cause in an expensive session within 30 seconds.

### Release 2: explain recurring waste

- Tool-to-turn association.
- Search/read thrashing detector.
- Retry and duplicate detection.
- Root-cause CLI report.
- Cost-driver API.

Success condition:

> User identifies top recurring waste mechanism across seven days.

### Release 3: prevent recurrence

- Baseline comparison.
- Workspace and profile thresholds.
- Budget alerts.
- CI cost-regression check.
- Model downgrade suggestions.
- Cache optimization suggestions.

Success condition:

> Token Lens warns before abnormal burn becomes large.

### Release 4: ecosystem integration

- OpenTelemetry GenAI import.
- Langfuse export import.
- Helicone export import.
- OpenInference normalization.
- Provider invoice reconciliation.

Success condition:

> Users debug costs without replacing existing observability systems.

## Privacy and correctness guardrails

- Store raw tokens and model IDs; compute cost from versioned `prices.json`.
- Mark exact, estimated, default-price, and provider-billed values separately.
- Preserve cache read/write semantics.
- Keep prompts and tool payloads local by default.
- Hash prompts by default; reveal raw prompt only with explicit local setting.
- Add retention controls for raw prompts and payloads.
- Show confidence beside every root-cause claim.
- Never claim exact tool cost when evidence is heuristic.
- Keep provider-billed tokens separate from locally estimated tokens.

## Strongest differentiator

Do not build another total-token dashboard. Build an evidence-backed explanation:

```text
Why did spend increase?

→ Context grew 4.8×
→ 31 file reads preceded expensive turn
→ Cache hit rate fell from 78% to 4%
→ One retry repeated full 38k-token context
→ Estimated excess: $1.37
→ Fix: cache static prefix, cap tool output, retry without full history
```

## Research sources

- OpenTelemetry GenAI spans: https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-spans.md
- OpenTelemetry GenAI attributes: https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/registry/attributes/gen-ai.md
- OpenLLMetry: https://github.com/traceloop/openllmetry/
- Langfuse token and cost tracking: https://langfuse.com/docs/observability/features/token-and-cost-tracking
- Langfuse Pulse: https://langfuse.com/changelog/2026-07-28-langfuse-pulse
- Helicone cost tracking: https://docs.helicone.ai/guides/cookbooks/cost-tracking
- Helicone repository: https://github.com/helicone/helicone/
- Braintrust cost reduction: https://www.braintrust.dev/articles/how-to-reduce-costs-for-llms-using-braintrust
- Braintrust trace observation: https://www.braintrust.dev/docs/observe/examine-traces
- Phoenix cost tracking: https://arize.com/docs/phoenix/tracing/how-to-tracing/cost-tracking
- Phoenix repository span attributes: https://github.com/Arize-ai/phoenix/blob/HEAD/.agents/skills/phoenix-tracing/references/span-llm.md
- OpenTelemetry GenAI observability: https://opentelemetry.io/blog/2026/genai-observability/
