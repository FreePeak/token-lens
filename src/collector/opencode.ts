import { Database } from "bun:sqlite";
import { existsSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import {
  insertToolCall,
  recomputeRollup,
  upsertSession,
  upsertTokenSnapshot,
  upsertTurn,
} from "../db/queries";
import { normalizeToolLabel } from "../shared/tools";

/**
 * OpenCode stores its data in an SQLite DB at
 *   ~/.local/share/opencode/opencode.db   (XDG data dir)
 *   or ~/.config/opencode/opencode.db     (older path)
 * Sessions aggregate tokens/cost directly so a single SQL scan is enough —
 * the message/part tables only need reading for tool-call attribution
 * and per-turn counts.
 */

export const OPENCODE_PROFILE = ".opencode";

/** Multiple candidate roots (XDG-first, then legacy ~/.config). */
function defaultOpenCodeHomeCandidates(): string[] {
  const home = homedir();
  return [
    join(home, ".local", "share", "opencode"),
    join(home, ".config", "opencode"),
    join(home, ".config", "OpenCode"),
  ];
}

export type OpenCodeRoot = {
  /** Home dir of the install (`~/.local/share/opencode`). */
  home: string;
  dbPath: string;
  /** Profile label written to `sessions.profile`. */
  label: typeof OPENCODE_PROFILE;
};

function probeDb(dbPath: string): boolean {
  if (!existsSync(dbPath)) return false;
  try {
    if (statSync(dbPath).size < 1) return false;
    const db = new Database(`file:${dbPath}?mode=ro`, { readonly: true, create: false });
    try {
      const r = db
        .query(`SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='session'`)
        .get() as { ok: number } | null;
      if (!r) return false;
      const part = db
        .query(`SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='part'`)
        .get() as { ok: number } | null;
      return !!part; // require session + part tables
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

/** Discover the OpenCode DB under one of the default home candidates. */
export function discoverOpenCodeRoots(overrideHome?: string): OpenCodeRoot[] {
  const candidates = overrideHome ? [overrideHome] : defaultOpenCodeHomeCandidates();
  for (const home of candidates) {
    if (!existsSync(home)) continue;
    const dbPath = join(home, "opencode.db");
    if (probeDb(dbPath)) return [{ home, dbPath, label: OPENCODE_PROFILE }];
  }
  return [];
}

/** OpenCode stores model as `{id, providerID, variant}` JSON. Reduce to flat id. */
export function normalizeOpenCodeSessionModel(raw: unknown): string {
  if (typeof raw !== "string" || !raw) return "";
  try {
    const o = JSON.parse(raw) as { id?: unknown; modelID?: unknown };
    if (typeof o.id === "string" && o.id) return o.id;
    if (typeof o.modelID === "string" && o.modelID) return o.modelID;
  } catch {
    /* fall through */
  }
  return raw;
}

type OpenCodeSessionRow = {
  id: string;
  directory: string;
  title: string;
  model: string | null;
  cost: number;
  tokens_input: number;
  tokens_output: number;
  tokens_reasoning: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
  time_created: number;
  time_updated: number;
};

type PartRow = {
  message_id: string;
  session_id: string;
  time_created: number;
  data: string;
};

type MessageRow = {
  id: string;
  data: string;
};

function firstUserPrompt(messages: MessageRow[]): string | null {
  for (const m of messages) {
    try {
      const o = JSON.parse(m.data) as { role?: string; content?: string };
      if (o.role === "user" && typeof o.content === "string" && o.content.trim()) {
        return o.content.replace(/\s+/g, " ").trim().slice(0, 240);
      }
    } catch {
      /* skip */
    }
  }
  return null;
}

function toolNameForPart(data: string): { name: string; label: string } | null {
  let o: { type?: string; tool?: string; state?: { status?: string; input?: unknown } } | null = null;
  try {
    o = JSON.parse(data) as typeof o;
  } catch {
    return null;
  }
  if (!o || o.type !== "tool" || typeof o.tool !== "string" || !o.tool) return null;
  const status = o.state?.status;
  const input = o.state?.input;
  const params = typeof input === "string" ? input : input != null ? JSON.stringify(input) : null;
  const label = normalizeToolLabel(o.tool, { params });
  return { name: o.tool, label, status: status ?? "completed" };
}

export type OpenCodeParseResult = { ok: boolean; sessions?: number; toolCalls?: number; error?: string };

/**
 * Parse one OpenCode SQLite DB and write metrics. Idempotent: reruns on the
 * same file re-upsert the same sessions / tool_calls.
 */
export async function parseOpenCodeDb(metricsDb: Database, root: OpenCodeRoot): Promise<OpenCodeParseResult> {
  if (!probeDb(root.dbPath)) return { ok: false, error: `db not readable: ${root.dbPath}` };

  const source = new Database(`file:${root.dbPath}?mode=ro`, { readonly: true, create: false });
  try {
    const sessions = source
      .query(
        `SELECT id, directory, title, model,
                COALESCE(cost, 0)         AS cost,
                COALESCE(tokens_input, 0) AS tokens_input,
                COALESCE(tokens_output, 0) AS tokens_output,
                COALESCE(tokens_reasoning, 0) AS tokens_reasoning,
                COALESCE(tokens_cache_read, 0) AS tokens_cache_read,
                COALESCE(tokens_cache_write, 0) AS tokens_cache_write,
                time_created, time_updated
         FROM session`,
      )
      .all() as OpenCodeSessionRow[];

    let totalTools = 0;
    for (const sess of sessions) {
      const messages = source
        .query(
          `SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created ASC`,
        )
        .all(sess.id) as MessageRow[];
      const parts = source
        .query(
          `SELECT message_id, session_id, time_created, data
           FROM part WHERE session_id = ? AND json_extract(data, '$.type') = 'tool'
           ORDER BY time_created ASC`,
        )
        .all(sess.id) as PartRow[];

      const model = normalizeOpenCodeSessionModel(sess.model);
      const firstPrompt = firstUserPrompt(messages);
      const duration =
        sess.time_updated > sess.time_created ? sess.time_updated - sess.time_created : null;

      metricsDb.transaction(() => {
        upsertSession(metricsDb, {
          conversation_id: sess.id,
          title: sess.title || firstPrompt || null,
          workspace: sess.directory,
          workspace_path: sess.directory,
          model: model || null,
          started_at: sess.time_created,
          ended_at: sess.time_updated,
          duration_ms: duration,
          source: "backfill",
          first_prompt: firstPrompt,
          profile: root.label,
          last_backfilled_at: sess.time_updated,
        });

        // One summary token snapshot per session. OpenCode aggregates
        // tokens at the session level, so we don't have per-message data.
        upsertTokenSnapshot(metricsDb, {
          conversation_id: sess.id,
          bubble_id: `oc:${sess.time_created}:summary`,
          input_tokens: sess.tokens_input,
          output_tokens: sess.tokens_output + sess.tokens_reasoning,
          cache_read_tokens: sess.tokens_cache_read,
          cache_write_tokens: sess.tokens_cache_write,
          model: model || null,
          created_at: sess.time_created,
          estimated: false,
          prompt: firstPrompt,
        });

        // Per-turn = count of messages (both user + assistant)
        let turnIdx = 0;
        for (const m of messages) {
          turnIdx++;
          let role = "assistant";
          try {
            const o = JSON.parse(m.data) as { role?: string };
            if (typeof o.role === "string") role = o.role;
          } catch {
            /* keep default */
          }
          upsertTurn(metricsDb, {
            conversation_id: sess.id,
            generation_id: `${m.id}`,
            status: role === "user" ? "user" : "responded",
            ended_at: sess.time_created, // opencode only has aggregated times; reuse
          });
          void turnIdx;
        }

        // Tool calls from `part` rows
        let toolIdx = 0;
        for (const p of parts) {
          const t = toolNameForPart(p.data);
          if (!t) continue;
          let realSuccess = true;
          try {
            const o = JSON.parse(p.data) as { state?: { status?: string; metadata?: { exit?: number } } };
            const meta = o.state?.metadata;
            const exitCode = typeof meta?.exit === "number" ? meta.exit : undefined;
            if (typeof exitCode === "number" && exitCode !== 0) realSuccess = false;
            else if (o.state?.status && /error|fail/i.test(o.state.status)) realSuccess = false;
          } catch {
            /* keep default */
          }
          toolIdx++;
          insertToolCall(metricsDb, {
            conversation_id: sess.id,
            generation_id: `${p.message_id}:tool:${toolIdx}`,
            tool_name: t.label,
            success: realSuccess,
            created_at: p.time_created,
          });
          totalTools++;
        }

        recomputeRollup(metricsDb, sess.id);
      })();
    }

    return { ok: true, sessions: sessions.length, toolCalls: totalTools };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    source.close();
  }
}

export type OpenCodeBackfillResult = {
  sessions: number;
  toolCalls: number;
  changed: number;
};

export async function backfillOpenCode(
  metricsDb: Database,
  opts: { resume?: boolean; opencodeHome?: string } = {},
): Promise<OpenCodeBackfillResult> {
  const roots = discoverOpenCodeRoots(opts.opencodeHome);
  if (!roots.length) return { sessions: 0, toolCalls: 0, changed: 0 };
  let totalSessions = 0;
  let totalTools = 0;
  for (const root of roots) {
    const r = await parseOpenCodeDb(metricsDb, root);
    if (r.ok) {
      totalSessions += r.sessions ?? 0;
      totalTools += r.toolCalls ?? 0;
    }
  }
  void opts;
  return { sessions: totalSessions, toolCalls: totalTools, changed: totalSessions };
}
