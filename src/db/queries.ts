import type { Database } from "bun:sqlite";
import { estimateCostUsd } from "../shared/prices";
import { isLeanKgTool, isReadTool, isSearchTool } from "../shared/tools";
import type { DriverRow, OverviewStats, SessionDetail, SessionRollup } from "../shared/types";

export function upsertSession(
  db: Database,
  row: {
    conversation_id: string;
    title?: string | null;
    workspace?: string | null;
    model?: string | null;
    mode?: string | null;
    started_at?: number | null;
    ended_at?: number | null;
    duration_ms?: number | null;
    source?: string;
    first_prompt?: string | null;
  },
): void {
  db.run(
    `INSERT INTO sessions (conversation_id, title, workspace, model, mode, started_at, ended_at, duration_ms, source, first_prompt)
     VALUES ($id, $title, $ws, $model, $mode, $start, $end, $dur, $source, $fp)
     ON CONFLICT(conversation_id) DO UPDATE SET
       title = COALESCE(excluded.title, sessions.title),
       workspace = COALESCE(excluded.workspace, sessions.workspace),
       model = COALESCE(excluded.model, sessions.model),
       mode = COALESCE(excluded.mode, sessions.mode),
       started_at = COALESCE(sessions.started_at, excluded.started_at),
       ended_at = COALESCE(excluded.ended_at, sessions.ended_at),
       duration_ms = COALESCE(excluded.duration_ms, sessions.duration_ms),
       first_prompt = COALESCE(excluded.first_prompt, sessions.first_prompt),
       source = CASE WHEN sessions.source = 'backfill' AND excluded.source = 'hook' THEN 'hook'
                     ELSE sessions.source END`,
    {
      $id: row.conversation_id,
      $title: row.title ?? null,
      $ws: row.workspace ?? null,
      $model: row.model ?? null,
      $mode: row.mode ?? null,
      $start: row.started_at ?? null,
      $end: row.ended_at ?? null,
      $dur: row.duration_ms ?? null,
      $source: row.source ?? "hook",
      $fp: row.first_prompt ?? null,
    },
  );
}

export function upsertTurn(
  db: Database,
  row: {
    conversation_id: string;
    generation_id: string;
    status?: string | null;
    started_at?: number | null;
    ended_at?: number | null;
  },
): void {
  db.run(
    `INSERT INTO turns (conversation_id, generation_id, status, started_at, ended_at)
     VALUES ($c, $g, $status, $start, $end)
     ON CONFLICT(conversation_id, generation_id) DO UPDATE SET
       status = COALESCE(excluded.status, turns.status),
       ended_at = COALESCE(excluded.ended_at, turns.ended_at)`,
    {
      $c: row.conversation_id,
      $g: row.generation_id,
      $status: row.status ?? null,
      $start: row.started_at ?? Date.now(),
      $end: row.ended_at ?? null,
    },
  );
}

export function insertToolCall(
  db: Database,
  row: {
    conversation_id: string;
    generation_id?: string | null;
    tool_name: string;
    duration_ms?: number | null;
    success?: boolean;
    created_at?: number;
  },
): void {
  db.run(
    `INSERT INTO tool_calls (conversation_id, generation_id, tool_name, duration_ms, success, created_at)
     VALUES ($c, $g, $name, $dur, $ok, $at)`,
    {
      $c: row.conversation_id,
      $g: row.generation_id ?? null,
      $name: row.tool_name,
      $dur: row.duration_ms ?? null,
      $ok: row.success === false ? 0 : 1,
      $at: row.created_at ?? Date.now(),
    },
  );
}

export function upsertTokenSnapshot(
  db: Database,
  row: {
    conversation_id: string;
    bubble_id: string;
    input_tokens: number;
    output_tokens: number;
    context_tokens?: number | null;
    model?: string | null;
    created_at?: number | null;
    estimated?: boolean;
  },
): void {
  db.run(
    `INSERT INTO token_snapshots (conversation_id, bubble_id, input_tokens, output_tokens, context_tokens, model, created_at, estimated)
     VALUES ($c, $b, $in, $out, $ctx, $model, $at, $est)
     ON CONFLICT(conversation_id, bubble_id) DO UPDATE SET
       input_tokens = CASE
         WHEN excluded.estimated = 0 THEN MAX(excluded.input_tokens, token_snapshots.input_tokens)
         WHEN token_snapshots.estimated = 0 THEN token_snapshots.input_tokens
         ELSE MAX(excluded.input_tokens, token_snapshots.input_tokens) END,
       output_tokens = CASE
         WHEN excluded.estimated = 0 THEN MAX(excluded.output_tokens, token_snapshots.output_tokens)
         WHEN token_snapshots.estimated = 0 THEN token_snapshots.output_tokens
         ELSE MAX(excluded.output_tokens, token_snapshots.output_tokens) END,
       context_tokens = COALESCE(excluded.context_tokens, token_snapshots.context_tokens),
       model = COALESCE(excluded.model, token_snapshots.model),
       estimated = CASE WHEN token_snapshots.estimated = 0 THEN 0 ELSE excluded.estimated END`,
    {
      $c: row.conversation_id,
      $b: row.bubble_id,
      $in: row.input_tokens,
      $out: row.output_tokens,
      $ctx: row.context_tokens ?? null,
      $model: row.model ?? null,
      $at: row.created_at ?? null,
      $est: row.estimated ? 1 : 0,
    },
  );
}

export function insertContextEvent(
  db: Database,
  row: {
    conversation_id: string;
    context_tokens?: number | null;
    context_usage_percent?: number | null;
    context_window_size?: number | null;
    created_at?: number;
  },
): void {
  db.run(
    `INSERT INTO context_events (conversation_id, context_tokens, context_usage_percent, context_window_size, created_at)
     VALUES ($c, $tok, $pct, $win, $at)`,
    {
      $c: row.conversation_id,
      $tok: row.context_tokens ?? null,
      $pct: row.context_usage_percent ?? null,
      $win: row.context_window_size ?? null,
      $at: row.created_at ?? Date.now(),
    },
  );
}

export function recomputeRollup(db: Database, conversationId: string): void {
  const session = db
    .query(`SELECT * FROM sessions WHERE conversation_id = ?`)
    .get(conversationId) as Record<string, unknown> | null;
  if (!session) return;

  const numTurns = (
    db.query(`SELECT COUNT(*) AS n FROM turns WHERE conversation_id = ?`).get(conversationId) as {
      n: number;
    }
  ).n;

  const toolRows = db
    .query(`SELECT tool_name FROM tool_calls WHERE conversation_id = ?`)
    .all(conversationId) as Array<{ tool_name: string }>;

  let reads = 0;
  let leankg = 0;
  let search = 0;
  for (const { tool_name } of toolRows) {
    if (isReadTool(tool_name)) reads++;
    if (isLeanKgTool(tool_name)) leankg++;
    if (isSearchTool(tool_name)) search++;
  }

  const tokens = db
    .query(
      `SELECT COALESCE(SUM(input_tokens),0) AS input_tokens,
              COALESCE(SUM(output_tokens),0) AS output_tokens,
              MAX(estimated) AS any_est
       FROM token_snapshots WHERE conversation_id = ?`,
    )
    .get(conversationId) as { input_tokens: number; output_tokens: number; any_est: number | null };

  // Prefer per-bubble model cost when snapshots carry models
  const byModel = db
    .query(
      `SELECT COALESCE(model, '') AS model,
              SUM(input_tokens) AS input_tokens,
              SUM(output_tokens) AS output_tokens
       FROM token_snapshots WHERE conversation_id = ?
       GROUP BY COALESCE(model, '')`,
    )
    .all(conversationId) as Array<{ model: string; input_tokens: number; output_tokens: number }>;

  const sessionModel = (session.model as string | null) ?? null;
  let cost = 0;
  if (byModel.length) {
    for (const row of byModel) {
      cost += estimateCostUsd(row.model || sessionModel, row.input_tokens, row.output_tokens);
    }
  } else {
    cost = estimateCostUsd(sessionModel, tokens.input_tokens, tokens.output_tokens);
  }

  const input = tokens.input_tokens;
  const output = tokens.output_tokens;
  const started = session.started_at as number | null;
  const ended = session.ended_at as number | null;
  const duration =
    (session.duration_ms as number | null) ??
    (started != null && ended != null ? ended - started : null);

  db.run(
    `INSERT INTO session_rollups (
       conversation_id, title, workspace, model, mode, started_at, ended_at, duration_ms,
       num_turns, tool_calls, file_reads, input_tokens, output_tokens, total_tokens, total_cost_usd,
       tokens_estimated, used_leankg, leankg_calls, search_calls, first_prompt
     ) VALUES ($id, $title, $ws, $model, $mode, $start, $end, $dur, $turns, $tools, $reads, $in, $out, $tot, $cost,
       $est, $lk, $lkc, $sc, $fp)
     ON CONFLICT(conversation_id) DO UPDATE SET
       title = excluded.title,
       workspace = excluded.workspace,
       model = excluded.model,
       mode = excluded.mode,
       started_at = excluded.started_at,
       ended_at = excluded.ended_at,
       duration_ms = excluded.duration_ms,
       num_turns = excluded.num_turns,
       tool_calls = excluded.tool_calls,
       file_reads = excluded.file_reads,
       input_tokens = excluded.input_tokens,
       output_tokens = excluded.output_tokens,
       total_tokens = excluded.total_tokens,
       total_cost_usd = excluded.total_cost_usd,
       tokens_estimated = excluded.tokens_estimated,
       used_leankg = excluded.used_leankg,
       leankg_calls = excluded.leankg_calls,
       search_calls = excluded.search_calls,
       first_prompt = excluded.first_prompt`,
    {
      $id: conversationId,
      $title: session.title ?? null,
      $ws: session.workspace ?? null,
      $model: sessionModel,
      $mode: session.mode ?? null,
      $start: started,
      $end: ended,
      $dur: duration,
      $turns: numTurns,
      $tools: toolRows.length,
      $reads: reads,
      $in: input,
      $out: output,
      $tot: input + output,
      $cost: cost,
      $est: tokens.any_est ? 1 : 0,
      $lk: leankg > 0 ? 1 : 0,
      $lkc: leankg,
      $sc: search,
      $fp: (session.first_prompt as string | null) ?? null,
    },
  );
}

export function recomputeAllRollups(db: Database): number {
  const ids = db
    .query(`SELECT conversation_id FROM sessions`)
    .all() as Array<{ conversation_id: string }>;
  const tx = db.transaction(() => {
    for (const { conversation_id } of ids) recomputeRollup(db, conversation_id);
  });
  tx();
  return ids.length;
}

export function listSessions(
  db: Database,
  opts: { sinceMs?: number; limit?: number } = {},
): SessionRollup[] {
  const limit = opts.limit ?? 200;
  if (opts.sinceMs != null) {
    return db
      .query(
        `SELECT * FROM session_rollups WHERE started_at >= ? OR started_at IS NULL
         ORDER BY total_cost_usd DESC, COALESCE(started_at, 0) DESC LIMIT ?`,
      )
      .all(opts.sinceMs, limit) as SessionRollup[];
  }
  return db
    .query(`SELECT * FROM session_rollups ORDER BY total_cost_usd DESC, COALESCE(started_at, 0) DESC LIMIT ?`)
    .all(limit) as SessionRollup[];
}

export function getOverview(db: Database, sinceMs?: number): OverviewStats {
  const row = (
    sinceMs != null
      ? db
          .query(
            `SELECT COUNT(*) AS sessions,
                    COALESCE(SUM(num_turns),0) AS num_turns,
                    COALESCE(SUM(tool_calls),0) AS tool_calls,
                    COALESCE(SUM(file_reads),0) AS file_reads,
                    COALESCE(SUM(input_tokens),0) AS input_tokens,
                    COALESCE(SUM(output_tokens),0) AS output_tokens,
                    COALESCE(SUM(total_tokens),0) AS total_tokens,
                    COALESCE(SUM(total_cost_usd),0) AS total_cost_usd
             FROM session_rollups WHERE started_at >= ? OR started_at IS NULL`,
          )
          .get(sinceMs)
      : db
          .query(
            `SELECT COUNT(*) AS sessions,
                    COALESCE(SUM(num_turns),0) AS num_turns,
                    COALESCE(SUM(tool_calls),0) AS tool_calls,
                    COALESCE(SUM(file_reads),0) AS file_reads,
                    COALESCE(SUM(input_tokens),0) AS input_tokens,
                    COALESCE(SUM(output_tokens),0) AS output_tokens,
                    COALESCE(SUM(total_tokens),0) AS total_tokens,
                    COALESCE(SUM(total_cost_usd),0) AS total_cost_usd
             FROM session_rollups`,
          )
          .get()
  ) as OverviewStats;
  return row;
}

export function getSessionDetail(db: Database, conversationId: string): SessionDetail | null {
  const rollup = db
    .query(`SELECT * FROM session_rollups WHERE conversation_id = ?`)
    .get(conversationId) as SessionRollup | null;
  if (!rollup) return null;

  const turns = db
    .query(
      `SELECT generation_id, status, started_at, ended_at FROM turns
       WHERE conversation_id = ? ORDER BY COALESCE(ended_at, started_at, 0)`,
    )
    .all(conversationId) as SessionDetail["turns"];

  const tools = db
    .query(
      `SELECT tool_name,
              COUNT(*) AS count,
              SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS failures
       FROM tool_calls WHERE conversation_id = ?
       GROUP BY tool_name ORDER BY count DESC`,
    )
    .all(conversationId) as SessionDetail["tools"];

  const token_snapshots = db
    .query(
      `SELECT bubble_id, input_tokens, output_tokens, context_tokens, model, created_at
       FROM token_snapshots WHERE conversation_id = ?
       ORDER BY COALESCE(created_at, 0)`,
    )
    .all(conversationId) as SessionDetail["token_snapshots"];

  return { ...rollup, turns, tools, token_snapshots };
}

export function getDrivers(
  db: Database,
  dimension: "tool" | "model" | "workspace",
  sinceMs?: number,
): DriverRow[] {
  if (dimension === "tool") {
    const sql =
      sinceMs != null
        ? `SELECT t.tool_name AS key,
                  COUNT(DISTINCT t.conversation_id) AS sessions,
                  COUNT(*) AS tool_calls,
                  0 AS input_tokens, 0 AS output_tokens, 0 AS total_tokens, 0 AS total_cost_usd
           FROM tool_calls t
           JOIN session_rollups r ON r.conversation_id = t.conversation_id
           WHERE r.started_at >= ? OR r.started_at IS NULL
           GROUP BY t.tool_name ORDER BY tool_calls DESC LIMIT 50`
        : `SELECT tool_name AS key,
                  COUNT(DISTINCT conversation_id) AS sessions,
                  COUNT(*) AS tool_calls,
                  0 AS input_tokens, 0 AS output_tokens, 0 AS total_tokens, 0 AS total_cost_usd
           FROM tool_calls GROUP BY tool_name ORDER BY tool_calls DESC LIMIT 50`;
    return (sinceMs != null ? db.query(sql).all(sinceMs) : db.query(sql).all()) as DriverRow[];
  }

  const col = dimension === "model" ? "model" : "workspace";
  const sql =
    sinceMs != null
      ? `SELECT COALESCE(${col}, '(unknown)') AS key,
                COUNT(*) AS sessions,
                COALESCE(SUM(tool_calls),0) AS tool_calls,
                COALESCE(SUM(input_tokens),0) AS input_tokens,
                COALESCE(SUM(output_tokens),0) AS output_tokens,
                COALESCE(SUM(total_tokens),0) AS total_tokens,
                COALESCE(SUM(total_cost_usd),0) AS total_cost_usd
         FROM session_rollups
         WHERE started_at >= ? OR started_at IS NULL
         GROUP BY COALESCE(${col}, '(unknown)')
         ORDER BY total_cost_usd DESC LIMIT 50`
      : `SELECT COALESCE(${col}, '(unknown)') AS key,
                COUNT(*) AS sessions,
                COALESCE(SUM(tool_calls),0) AS tool_calls,
                COALESCE(SUM(input_tokens),0) AS input_tokens,
                COALESCE(SUM(output_tokens),0) AS output_tokens,
                COALESCE(SUM(total_tokens),0) AS total_tokens,
                COALESCE(SUM(total_cost_usd),0) AS total_cost_usd
         FROM session_rollups
         GROUP BY COALESCE(${col}, '(unknown)')
         ORDER BY total_cost_usd DESC LIMIT 50`;
  return (sinceMs != null ? db.query(sql).all(sinceMs) : db.query(sql).all()) as DriverRow[];
}

export function isFileReadTool(name: string): boolean {
  return isReadTool(name);
}
