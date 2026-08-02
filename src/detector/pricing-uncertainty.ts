// Detector: pricing_uncertainty / data_quality.
// Fires when the session used a model whose pricing is unknown,
// or when no model is recorded at all and tokens are non-zero.
import type { Database } from "bun:sqlite";
import { clampConfidence, insertRootCauseEvent } from "../db/root-causes";
import { getPricingStatus } from "../shared/confidence";

type Evidence = {
  unknown_model: string | null;
  observed_input_tokens: number;
  observed_cost_usd: number;
};

type Detected = {
  conversation_id: string;
  generation_id: string | null;
  category: "pricing_uncertainty";
  confidence: number;
  observed_cost_usd: number | null;
  baseline_cost_usd: number | null;
  evidence_json: string;
  recommendation: string;
};

const RECOMMENDATION =
  "Update prices.json with this model or import a provider invoice — current cost is an estimate from default rates.";

export function detectPricingUncertainty(db: Database, conversationId: string): Detected | null {
  const row = db
    .query(
      `SELECT model,
              COALESCE(SUM(input_tokens), 0)  AS input_tokens,
              COALESCE(SUM(total_cost_usd), 0) AS cost_usd
         FROM turns WHERE conversation_id = ?
         GROUP BY model`,
    )
    .all(conversationId) as Array<{ model: string | null; input_tokens: number; cost_usd: number }>;

  if (!row.length) return null;

  let worstModel: string | null = null;
  let worstInput = 0;
  let worstCost = 0;
  let anyUnknown = false;

  for (const r of row) {
    const m = r.model && r.model !== "default" ? r.model : null;
    const status = getPricingStatus(m);
    if (status === "default_price" && r.input_tokens > 0) {
      anyUnknown = true;
      if (r.input_tokens > worstInput) {
        worstModel = m;
        worstInput = r.input_tokens;
        worstCost = r.cost_usd;
      }
    }
  }

  if (!anyUnknown) return null;

  const confidence = clampConfidence(
    worstInput > 50_000 ? 0.95 : worstInput > 10_000 ? 0.85 : 0.7,
  );

  const evidence: Evidence = {
    unknown_model: worstModel,
    observed_input_tokens: worstInput,
    observed_cost_usd: worstCost,
  };

  insertRootCauseEvent(db, {
    conversation_id: conversationId,
    generation_id: null,
    category: "pricing_uncertainty",
    confidence,
    observed_cost_usd: worstCost,
    baseline_cost_usd: null,
    evidence_json: JSON.stringify(evidence),
    recommendation: RECOMMENDATION,
  });

  return {
    conversation_id: conversationId,
    generation_id: null,
    category: "pricing_uncertainty",
    confidence,
    observed_cost_usd: worstCost,
    baseline_cost_usd: null,
    evidence_json: JSON.stringify(evidence),
    recommendation: RECOMMENDATION,
  };
}
