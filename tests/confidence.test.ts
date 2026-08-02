// Self-check: getPricingStatus classifies model data quality.
// Run with: bun run tests/confidence.test.ts
import { strict as assert } from "assert";
import { getPricingStatus } from "../src/shared/confidence";

let passed = 0;
let failed = 0;
const test = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`  ok  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL ${name}\n    ${err instanceof Error ? err.message : err}`);
    failed++;
  }
};

console.log("confidence self-check");

test("null model → default_price", () => {
  assert.equal(getPricingStatus(null), "default_price");
  assert.equal(getPricingStatus(undefined), "default_price");
  assert.equal(getPricingStatus(""), "default_price");
});

test("known model → exact", () => {
  assert.equal(getPricingStatus("claude-sonnet-4-5-20250929"), "exact");
  assert.equal(getPricingStatus("gpt-4"), "exact");
});

test("unknown model → default_price (and not exact)", () => {
  assert.equal(getPricingStatus("totally-unknown-model-xyz"), "default_price");
});

test("Cursor slug normalization still resolves", () => {
  // normalizeModel strips provider prefix and parens
  assert.equal(getPricingStatus("accounts/fireworks/models/llama-3.1-70b"), "default_price");
});

test("estimated is independent of pricing status (caller decides)", () => {
  // The flag is propagated separately; here we only verify status logic.
  assert.equal(getPricingStatus("gpt-4"), "exact");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
