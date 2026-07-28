// Fetch latest model prices from OpenRouter. Default: print Markdown to stdout.
// --apply: merge into prices.json (USD per 1M). Strips <vendor>/<model> prefix
// and leading "~" so OpenRouter slugs align with bare keys already in prices.json.
// Existing keys with no OpenRouter counterpart (e.g. `coding-cheap`, hand-curated
// aliases) are preserved.

import { readFileSync, writeFileSync } from "fs";

const SRC = "https://openrouter.ai/api/v1/models";
const PRICES_PATH = new URL("../prices.json", import.meta.url).pathname;

type RawPrice = {
  prompt?: string;
  completion?: string;
  input_cache_read?: string;
  input_cache_write?: string;
};
type Model = { id: string; pricing: RawPrice };
type Row = { id: string; input: number; output: number; cache_read: number; cache_write: number; hasAny: boolean };
type Stored = { input: number; output: number; cache_read?: number; cache_write?: number };

function toPerMillion(s: string | undefined): number | null {
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1_000_000 * 1e6) / 1e6 : null;
}

// Drop "<vendor>/" prefix and a leading "~" so `anthropic/claude-sonnet-4.5` →
// `claude-sonnet-4.5` and `~google/gemini-pro-latest` → `gemini-pro-latest`.
function bareKey(id: string): string {
  const i = id.lastIndexOf("/");
  const tail = i >= 0 ? id.slice(i + 1) : id;
  return tail.replace(/^~/, "");
}

async function fetchRows(): Promise<Row[]> {
  const res = await fetch(SRC);
  if (!res.ok) {
    console.error(`OpenRouter ${res.status} ${res.statusText}`);
    process.exit(1);
  }
  const body = (await res.json()) as { data: Model[] };
  return body.data.map((m) => {
    const prompt = toPerMillion(m.pricing.prompt);
    const completion = toPerMillion(m.pricing.completion);
    return {
      id: m.id,
      input: prompt ?? 0,
      output: completion ?? 0,
      cache_read: toPerMillion(m.pricing.input_cache_read) ?? 0,
      cache_write: toPerMillion(m.pricing.input_cache_write) ?? 0,
      hasAny: prompt != null || completion != null,
    };
  });
}

function printTable(rows: Row[]): void {
  const fmt = (n: number) => (n > 0 ? n.toFixed(4) : "-");
  const sorted = [...rows].sort((a, b) => a.id.localeCompare(b.id));
  console.log(`| model | input | output | cache_read | cache_write |`);
  console.log(`|---|---:|---:|---:|---:|`);
  for (const r of sorted) {
    console.log(`| ${r.id} | ${fmt(r.input)} | ${fmt(r.output)} | ${fmt(r.cache_read)} | ${fmt(r.cache_write)} |`);
  }
}

function applyMerge(rows: Row[]): { added: number; updated: number; preserved: number } {
  const prices = JSON.parse(readFileSync(PRICES_PATH, "utf-8")) as {
    default: Stored;
    models: Record<string, Stored>;
  };
  const upstream = new Map<string, Stored>();
  for (const r of rows) {
    if (!r.hasAny) continue;
    const key = bareKey(r.id);
    if (!key) continue;
    // Skip rows with no signal — keep existing entry untouched.
    if (r.input <= 0 && r.output <= 0 && r.cache_read <= 0 && r.cache_write <= 0) continue;
    upstream.set(key, {
      input: r.input,
      output: r.output,
      ...(r.cache_read > 0 && { cache_read: r.cache_read }),
      ...(r.cache_write > 0 && { cache_write: r.cache_write }),
    });
  }
  let added = 0;
  let updated = 0;
  let preserved = 0;
  for (const [key, rate] of upstream) {
    if (key in prices.models) updated++;
    else added++;
    prices.models[key] = rate;
  }
  for (const existing of Object.keys(prices.models)) {
    if (!upstream.has(existing)) preserved++;
  }
  writeFileSync(PRICES_PATH, JSON.stringify(prices, null, 2) + "\n", "utf-8");
  return { added, updated, preserved };
}

const args = process.argv.slice(2);
const apply = args.includes("--apply") || args.includes("--write");

const rows = await fetchRows();
if (apply) {
  const { added, updated, preserved } = applyMerge(rows);
  console.log(`Updated ${updated}, added ${added}, preserved ${preserved} (${PRICES_PATH})`);
} else {
  printTable(rows);
}

// ponytail: tiered pricing (OpenRouter `overrides`) ignored — base tier only.
// ponytail: --apply skips rows where all four prices are zero/empty (e.g. :free
// aliases); they would otherwise erase existing hand-curated entries.
// ponytail: --apply strips vendor prefix to bare key, so `anthropic/claude-*`
// overwrites `claude-*`. Two-vendor price divergence is hidden — fine when both
// vendors serve the same model at parity, lossy when they don't. Add when a
// divergence shows up in real bills.
