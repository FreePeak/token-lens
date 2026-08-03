// Pricing / data-quality classification for a model string.
// Status reflects pricing-book coverage, not token accuracy (that's `estimated`).
import prices from "../../prices.json";
import { normalizeModel } from "./prices";

export type PricingStatus = "exact" | "default_price";

const MODEL_KEYS = Object.keys(prices.models as Record<string, unknown>).map((k) =>
  normalizeModel(k),
);

export function getPricingStatus(model: string | null | undefined): PricingStatus {
  if (!model) return "default_price";
  const lower = normalizeModel(model);
  for (const key of MODEL_KEYS) {
    if (lower === key || lower.includes(key)) return "exact";
  }
  return "default_price";
}
