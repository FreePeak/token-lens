// Detector: context_accumulation.
// Fires when input tokens grew ≥ 3× across the session AND there are ≥ 2 turns.
// Confidence = min(1, (growth_ratio - 1) / 3) bumped by +0.1 if max context usage ≥ 80%.
import type { Database } from "bun:sqlite";
import { clampConfidence, insertRootCauseEvent } from "../db/root-causes";

type Evidence = {
  input_growth_ratio: number;
  baseline_input: number;
  peak_input: number;
  num_turns: number;
  max_context_percent: number | null;
};

type Detected = {
  conversation_id: string;
  generation_id: string | null;
  category: "context_accumulation";
  confidence: number;
  observed_cost_usd: number | null;
  baseline_cost_usd: number | null;
  evidence_json: string;
  recommendation: string;
};

const RECOMMENDATION =
  "Shorten history, compact earlier, or start a fresh session — context grew beyond baseline and inflated input cost.";

export function detectContextGrowth(db: Database, conversationId: string): Detected | null {
  const rows = db
    .query(
      `SELECT COALESCE(input_tokens, 0) AS input_tokens
         FROM turns WHERE conversation_id = ? ORDER BY COALESCE(ended_at, started_at, 0)`,
    )
    .all(conversationId) as Array<{ input_tokens: number }>;

  if (rows.length < 2) return null;

  const inputs = rows.map((r) => r.input_tokens | 0);
  const baseline = inputs[0] ?? 0;
  if (baseline <= 0) return null;
  const peak = inputs.reduce((m, n) => (n > m ? n : m), 0);
  const growth = peak / baseline;
  if (growth < 3) return null;

  const ctxRow = db
    .query(
      `SELECT MAX(context_usage_percent) AS max_pct
         FROM context_events WHERE conversation_id = ?`,
    )
    .get(conversationId) as { max_pct: number | null };
  const maxPct = ctxRow?.max_pct ?? null;
  const highPressure = maxPct != null && maxPct >= 80;

  const baseConf = Math.min(1, (growth - 1) / 3);
  const conf = clampConfidence(baseConf + (highPressure ? 0.1 : 0));

  // observed = peak turn cost; baseline = what the peak would cost at baseline*growth
  const observed = peak; // in tokens; cost is on a separate column
  const baselineCost = baseline;

  const evidence: Evidence = {
    input_growth_ratio: Number(growth.toFixed(2)),
    baseline_input: baseline,
    peak_input: peak,
    num_turns: rows.length,
    max_context_percent: maxPct,
  };

  const id = insertRootCauseEvent(db, {
    conversation_id: conversationId,
    generation_id: null,
    category: "context_accumulation",
    confidence: conf,
    observed_cost_usd: null,
    baseline_cost_usd: null,
    evidence_json: JSON.stringify(evidence),
    recommendation: RECOMMENDATION,
  });

  return {
    conversation_id: conversationId,
    generation_id: null,
    category: "context_accumulation",
    confidence: conf,
    observed_cost_usd: observed,
    baseline_cost_usd: baselineCost,
    evidence_json: JSON.stringify(evidence),
    recommendation: RECOMMENDATION,
  };
}
