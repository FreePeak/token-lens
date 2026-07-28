// Self-check: cache hit, invalidate, recompute, count-sentinel refresh.
// Run with: bun run tests/overview-cache.test.ts
import { strict as assert } from "assert";
import { openMetricsDb } from "../src/db/schema";
import { getOverviewCached, invalidateOverviewCache } from "../src/db/overview-cache";

function newDb() {
  return openMetricsDb(":memory:");
}

function seedRollup(
  db: ReturnType<typeof openMetricsDb>,
  id: string,
  totalTokens: number,
  startedAt: number | null = null,
) {
  db.run(
    `INSERT INTO session_rollups
       (conversation_id, title, workspace, model, mode, started_at, ended_at, duration_ms,
        num_turns, tool_calls, file_reads, input_tokens, output_tokens, total_tokens, total_cost_usd,
        tokens_estimated, used_leankg, leankg_calls, search_calls, first_prompt, profile)
     VALUES ($id, NULL, NULL, 'gpt-4', NULL, $start, 0, 0,
        0, 0, 0, 0, 0, $tot, 0, 0, 0, 0, 0, NULL, NULL)`,
    { $id: id, $tot: totalTokens, $start: startedAt },
  );
}

function cacheRow(db: ReturnType<typeof openMetricsDb>) {
  return db
    .query(`SELECT computed_at, source_session_count FROM overview_cache WHERE key = 'default'`)
    .get() as { computed_at: number; source_session_count: number } | null;
}

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

console.log("overview-cache self-check");

test("cold cache recomputes and writes row", () => {
  const db = newDb();
  seedRollup(db, "a", 100);
  seedRollup(db, "b", 200);
  const stats = getOverviewCached(db);
  assert.equal(stats.sessions, 2);
  assert.equal(stats.total_tokens, 300);
  const row = cacheRow(db);
  assert.ok(row, "cache row should exist");
  assert.equal(row.source_session_count, 2);
  db.close();
});

test("warm cache returns same payload without recompute", () => {
  const db = newDb();
  seedRollup(db, "a", 100);
  getOverviewCached(db);
  const first = cacheRow(db)!;
  const second = getOverviewCached(db);
  const row2 = cacheRow(db)!;
  assert.equal(second.total_tokens, 100);
  assert.equal(first.computed_at, row2.computed_at, "computed_at unchanged → cache hit");
  db.close();
});

test("invalidate forces recompute", () => {
  const db = newDb();
  seedRollup(db, "a", 100);
  getOverviewCached(db);
  const before = cacheRow(db)!;
  invalidateOverviewCache(db);
  seedRollup(db, "b", 50);
  getOverviewCached(db);
  const after = cacheRow(db)!;
  assert.equal(after.source_session_count, 2);
  assert.notEqual(before.computed_at, undefined, "row was written before");
  // payload proves recompute ran (total_tokens moved from 100 → 150)
  assert.equal(
    JSON.parse(after && (db.query(`SELECT payload FROM overview_cache WHERE key='default'`).get() as { payload: string }).payload).total_tokens,
    150,
  );
  db.close();
});

test("new session_rollups row triggers count-sentinel recompute", () => {
  const db = newDb();
  seedRollup(db, "a", 100);
  getOverviewCached(db);
  const beforeCount = cacheRow(db)!.source_session_count;
  seedRollup(db, "b", 250);
  const stats = getOverviewCached(db);
  const after = cacheRow(db)!;
  assert.equal(stats.total_tokens, 350);
  assert.equal(after.source_session_count, 2);
  assert.ok(after.source_session_count > beforeCount, "count grew → cache refreshed");
  db.close();
});

test("filtered overview bypasses cache", () => {
  const db = newDb();
  const now = Date.now();
  seedRollup(db, "a", 100, now);
  seedRollup(db, "old", 999, 0);
  getOverviewCached(db); // warm "default" cache (sees both rows)
  assert.ok(cacheRow(db));
  const filtered = getOverviewCached(db, now - 1);
  assert.equal(filtered.sessions, 1, "only the recent row passes the sinceMs filter");
  // "default" row untouched (filtered path doesn't read OR write it)
  assert.ok(cacheRow(db));
  db.close();
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
