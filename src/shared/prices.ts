import prices from "../../prices.json";

type Price = {
  input: number;
  output: number;
  /** USD per 1M cache-read tokens; if omitted, derived from input × provider multiplier. */
  cache_read?: number;
  /** USD per 1M cache-write tokens; if omitted, derived from input × provider multiplier. */
  cache_write?: number;
};

export function estimateCostUsd(
  model: string | null | undefined,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens = 0,
  cacheWriteTokens = 0,
): number {
  const rate = resolvePrice(model);
  const { read: cacheReadRate, write: cacheWriteRate } = cacheRates(rate, model);
  return (
    (inputTokens / 1_000_000) * rate.input +
    (outputTokens / 1_000_000) * rate.output +
    (cacheReadTokens / 1_000_000) * cacheReadRate +
    (cacheWriteTokens / 1_000_000) * cacheWriteRate
  );
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

/**
 * Provider cache multipliers when prices.json omits cache_read / cache_write.
 * - Claude / MiniMax / GLM / Kimi: Anthropic-style read 0.1×, write 1.25×
 * - OpenAI / Composer: cached input ~0.5×, write ≈ input
 * - Gemini / Grok: read ~0.25×, write ≈ input
 * - DeepSeek: read 0.1×, write ≈ input
 */
export function cacheRates(
  rate: Price,
  model: string | null | undefined,
): { read: number; write: number } {
  if (rate.cache_read != null && rate.cache_write != null) {
    return { read: rate.cache_read, write: rate.cache_write };
  }
  const m = normalizeModel(model ?? "");
  let readMul = 0.1;
  let writeMul = 1.25;
  if (m.includes("gpt") || /^o[0-9]/.test(m) || m.includes("composer")) {
    readMul = 0.5;
    writeMul = 1.0;
  } else if (m.includes("gemini") || m.includes("grok")) {
    readMul = 0.25;
    writeMul = 1.0;
  } else if (m.includes("deepseek") || m.includes("coding-cheap")) {
    readMul = 0.1;
    writeMul = 1.0;
  }
  return {
    read: rate.cache_read ?? rate.input * readMul,
    write: rate.cache_write ?? rate.input * writeMul,
  };
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
