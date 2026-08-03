// CRUD helpers for root_cause_events. Detectors call insertRootCauseEvent;
// CLI / API / dashboard call listRootCauseEvents.
// Run with: bun run tests/root-cause-crud.test.ts
import type { Database } from "bun:sqlite";
import type { RootCauseCategory, RootCauseEvent } from "../shared/types";

export function insertRootCauseEvent(
  db: Database,
  ev: Omit<RootCauseEvent, "id" | "created_at"> & { created_at?: number },
): number {
  const created = ev.created_at ?? Date.now();
  const r = db
    .query(
      `INSERT INTO root_cause_events
         (conversation_id, generation_id, category, confidence,
          observed_cost_usd, baseline_cost_usd, evidence_json, recommendation, created_at)
       VALUES ($c, $g, $cat, $conf, $obs, $base, $ev, $rec, $at)
       RETURNING id`,
    )
    .get({
      $c: ev.conversation_id,
      $g: ev.generation_id ?? null,
      $cat: ev.category,
      $conf: clampConfidence(ev.confidence),
      $obs: ev.observed_cost_usd ?? null,
      $base: ev.baseline_cost_usd ?? null,
      $ev: ev.evidence_json,
      $rec: ev.recommendation,
      $at: created,
    }) as { id: number };
  return r.id;
}

export function clearRootCauseEvents(db: Database, conversationId: string): void {
  db.run(`DELETE FROM root_cause_events WHERE conversation_id = ?`, [conversationId]);
}

export function listRootCauseEvents(
  db: Database,
  opts: { conversationId?: string; category?: RootCauseCategory; limit?: number } = {},
): RootCauseEvent[] {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (opts.conversationId) {
    clauses.push("conversation_id = ?");
    params.push(opts.conversationId);
  }
  if (opts.category) {
    clauses.push("category = ?");
    params.push(opts.category);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = opts.limit ?? 200;
  params.push(limit);
  return db
    .query(
      `SELECT id, conversation_id, generation_id, category, confidence,
              observed_cost_usd, baseline_cost_usd, evidence_json, recommendation, created_at
         FROM root_cause_events ${where}
         ORDER BY confidence DESC, observed_cost_usd DESC NULLS LAST
         LIMIT ?`,
    )
    .all(...params) as RootCauseEvent[];
}

/** Clamp confidence to [0, 1] — Privacy & correctness guardrail (docs plan §guardrails). */
export function clampConfidence(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
