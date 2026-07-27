import prices from "../../prices.json";

type Price = { input: number; output: number };

export function estimateCostUsd(
  model: string | null | undefined,
  inputTokens: number,
  outputTokens: number,
): number {
  const rate = resolvePrice(model);
  return (inputTokens / 1_000_000) * rate.input + (outputTokens / 1_000_000) * rate.output;
}

/** Normalize Cursor slugs like `minimax/MiniMax-M3(thinking)` → `minimax-m3`. */
export function normalizeModel(model: string): string {
  let s = model.toLowerCase().trim();
  // Drop provider prefix: minimax/..., ocg/..., accounts/fireworks/models/...
  if (s.includes("/")) s = s.slice(s.lastIndexOf("/") + 1);
  // Drop mode suffix: (thinking), (reasoning), etc.
  s = s.replace(/\([^)]*\)/g, "");
  return s.replace(/[\s_]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

function resolvePrice(model: string | null | undefined): Price {
  if (!model) return prices.default as Price;
  const lower = normalizeModel(model);
  // Longest key first so minimax-m2.7-highspeed beats minimax-m2.7 / minimax
  const entries = Object.entries(prices.models as Record<string, Price>).sort(
    (a, b) => b[0].length - a[0].length,
  );
  for (const [key, rate] of entries) {
    const k = normalizeModel(key);
    if (lower === k || lower.includes(k)) return rate;
  }
  return prices.default as Price;
}
