import { Database } from "bun:sqlite";
import {
  insertToolCall,
  recomputeAllRollups,
  upsertSession,
  upsertTokenSnapshot,
  upsertTurn,
} from "../db/queries";
import { discoverCursorStateDbs } from "../db/schema";
import { charsToTokens, contentChars, normalizeToolLabel } from "../shared/tools";

const MAX_VALUE_CHARS = 2_000_000;
const PROGRESS_EVERY = 5_000;

type ComposerHeader = {
  composerId?: string;
  name?: string;
  subtitle?: string;
  createdAt?: number;
  lastUpdatedAt?: number;
  unifiedMode?: string;
  workspaceIdentifier?: { id?: string } | string;
};

type Bubble = {
  type?: number | string;
  tokenCount?: { inputTokens?: number; outputTokens?: number };
  contextWindowStatusAtCreation?: { tokensUsed?: number };
  modelInfo?: { modelName?: string };
  text?: string;
  richText?: string;
  toolFormerData?: {
    name?: string;
    tool?: number | string;
    rawArgs?: string;
    params?: string;
    result?: unknown;
    status?: string;
  };
  toolResults?: Array<{ toolName?: string; name?: string }>;
  allThinkingBlocks?: Array<string | { text?: string; content?: string }>;
  requestId?: string;
  createdAt?: number | string;
  capabilityType?: number;
};

type ComposerMeta = {
  composerId: string;
  workspaceId: string | null;
  createdAt: number | null;
  lastUpdatedAt: number | null;
  title: string | null;
  mode: string | null;
};

function decodeValue(v: unknown): string {
  if (typeof v === "string") return v;
  if (v instanceof Uint8Array) return new TextDecoder().decode(v);
  if (Buffer.isBuffer(v)) return v.toString("utf8");
  return String(v ?? "");
}

function workspaceFromHeader(h: ComposerHeader): string | null {
  const w = h.workspaceIdentifier;
  if (!w) return null;
  if (typeof w === "string") return w;
  return w.id ?? null;
}

function openCursorDb(path: string): Database {
  return new Database(`file:${path}?mode=ro`, { readonly: true, create: false });
}

function thinkingChars(blocks: Bubble["allThinkingBlocks"]): number {
  if (!blocks?.length) return 0;
  let n = 0;
  for (const b of blocks) {
    if (typeof b === "string") n += b.length;
    else if (b && typeof b === "object") n += (b.text ?? b.content ?? "").length;
  }
  return n;
}

function toolPayloadChars(tf: Bubble["toolFormerData"]): number {
  if (!tf) return 0;
  let n = (tf.rawArgs ?? "").length + (tf.params ?? "").length;
  if (tf.result != null) {
    n += typeof tf.result === "string" ? tf.result.length : JSON.stringify(tf.result).length;
  }
  return n;
}

function createdAtMs(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

function parseBubbleKey(key: string): { conversationId: string; bubbleId: string } | null {
  // bubbleId:<composerUuid>:<bubbleId>
  if (!key.startsWith("bubbleId:")) return null;
  const rest = key.slice("bubbleId:".length);
  const i = rest.indexOf(":");
  if (i <= 0) return null;
  return { conversationId: rest.slice(0, i), bubbleId: rest.slice(i + 1) };
}

export type BackfillResult = {
  sessions: number;
  bubbles: number;
  toolCalls: number;
  estimatedSessions: number;
  path: string;
  paths: string[];
  skippedHuge: number;
};

function clearDerived(metricsDb: Database): void {
  metricsDb.exec(`
    DELETE FROM tool_calls;
    DELETE FROM turns;
    DELETE FROM token_snapshots;
    DELETE FROM session_rollups;
  `);
}

function loadComposers(cursor: Database): ComposerMeta[] {
  const hasTable = cursor
    .query(`SELECT name FROM sqlite_master WHERE type='table' AND name='composerHeaders'`)
    .get() as { name: string } | null;
  if (!hasTable) return [];

  const rows = cursor
    .query(`SELECT composerId, workspaceId, createdAt, lastUpdatedAt, value FROM composerHeaders`)
    .all() as Array<{
    composerId: string;
    workspaceId: string | null;
    createdAt: number | null;
    lastUpdatedAt: number | null;
    value: string;
  }>;

  const composers: ComposerMeta[] = [];
  for (const row of rows) {
    let parsed: ComposerHeader = {};
    try {
      parsed = JSON.parse(row.value) as ComposerHeader;
    } catch {
      /* ignore */
    }
    composers.push({
      composerId: row.composerId,
      workspaceId: row.workspaceId ?? workspaceFromHeader(parsed),
      createdAt: row.createdAt ?? parsed.createdAt ?? null,
      lastUpdatedAt: row.lastUpdatedAt ?? parsed.lastUpdatedAt ?? null,
      title: parsed.name ?? parsed.subtitle ?? null,
      mode: parsed.unifiedMode ?? null,
    });
  }
  return composers;
}

type Acc = {
  model: string | null;
  exactIn: number;
  exactOut: number;
  estIn: number;
  estOut: number;
  sawExact: boolean;
  toolSeen: Set<string>;
  firstPrompt: string | null;
};

function processBubble(
  metricsDb: Database,
  conversationId: string,
  bubbleId: string,
  data: Bubble,
  acc: Acc,
  counts: { bubbles: number; toolCalls: number },
): void {
  const model = data.modelInfo?.modelName ?? null;
  if (model) acc.model = acc.model ?? model;
  const at = createdAtMs(data.createdAt);
  const tc = data.tokenCount ?? {};
  let input = Number(tc.inputTokens ?? 0);
  let output = Number(tc.outputTokens ?? 0);
  const cws = data.contextWindowStatusAtCreation?.tokensUsed;
  const contextTokens = typeof cws === "number" ? cws : null;
  let estimated = false;

  const think = thinkingChars(data.allThinkingBlocks);
  const textLen = (data.text ?? "").length;
  const toolChars = toolPayloadChars(data.toolFormerData);
  const isUser = data.type === 1 || data.type === "user";
  if (isUser && !acc.firstPrompt) {
    const raw = (data.text ?? data.richText ?? "").trim().replace(/\s+/g, " ");
    if (raw) acc.firstPrompt = raw.slice(0, 240);
  }
  const isAssistant =
    data.type === 2 ||
    data.type === "ai" ||
    data.capabilityType != null ||
    data.toolFormerData != null;

  if (input === 0 && output === 0) {
    if (contextTokens != null && contextTokens > 0) {
      input = contextTokens;
      estimated = true;
    }
    if (isUser) {
      const u = charsToTokens(contentChars([data.text, data.richText]));
      if (u) {
        input = Math.max(input, u);
        estimated = true;
      }
    }
    if (isAssistant) {
      const o = charsToTokens(textLen + think);
      const toolTok = charsToTokens(toolChars);
      if (o) {
        output = o;
        estimated = true;
      }
      if (toolTok) {
        input += Math.floor(toolTok * 0.85);
        output += Math.floor(toolTok * 0.15);
        estimated = true;
      }
    }
  } else {
    acc.sawExact = true;
  }

  if (input > 0 || output > 0 || contextTokens != null) {
    upsertTokenSnapshot(metricsDb, {
      conversation_id: conversationId,
      bubble_id: bubbleId,
      input_tokens: input,
      output_tokens: output,
      context_tokens: contextTokens,
      model,
      created_at: at,
      estimated,
    });
    counts.bubbles++;
    if (estimated) {
      acc.estIn += input;
      acc.estOut += output;
    } else {
      acc.exactIn += input;
      acc.exactOut += output;
    }
  }

  if (isUser) {
    const gen = (typeof data.requestId === "string" && data.requestId) || bubbleId;
    upsertTurn(metricsDb, {
      conversation_id: conversationId,
      generation_id: gen,
      status: "user",
      ended_at: at,
    });
  }

  const tf = data.toolFormerData;
  const tfName = tf?.name;
  if (tfName) {
    const label = normalizeToolLabel(tfName, { rawArgs: tf?.rawArgs, params: tf?.params });
    const dedupe = `${bubbleId}:${label}`;
    if (!acc.toolSeen.has(dedupe)) {
      acc.toolSeen.add(dedupe);
      insertToolCall(metricsDb, {
        conversation_id: conversationId,
        tool_name: label,
        success: tf?.status !== "error",
        created_at: at ?? Date.now(),
      });
      counts.toolCalls++;
    }
  }
  if (Array.isArray(data.toolResults)) {
    for (const t of data.toolResults) {
      const name = t.toolName ?? t.name;
      if (!name) continue;
      const label = normalizeToolLabel(name);
      const dedupe = `${bubbleId}:tr:${label}`;
      if (acc.toolSeen.has(dedupe)) continue;
      acc.toolSeen.add(dedupe);
      insertToolCall(metricsDb, {
        conversation_id: conversationId,
        tool_name: label,
        success: true,
        created_at: at ?? Date.now(),
      });
      counts.toolCalls++;
    }
  }
}

/** Single-pass scan of one state.vscdb (no per-composer LIKE). */
export function backfillFromCursor(
  metricsDb: Database,
  statePath: string,
  opts: { clear?: boolean; rollup?: boolean } = {},
): BackfillResult {
  const clear = opts.clear !== false;
  const rollup = opts.rollup !== false;
  const cursor = openCursorDb(statePath);
  let sessions = 0;
  let estimatedSessions = 0;
  let skippedHuge = 0;
  const counts = { bubbles: 0, toolCalls: 0 };

  try {
    if (clear) clearDerived(metricsDb);

    const composers = loadComposers(cursor);
    const knownIds = new Set(composers.map((c) => c.composerId));
    const filterKnown = knownIds.size > 0;

    metricsDb.transaction(() => {
      for (const c of composers) {
        upsertSession(metricsDb, {
          conversation_id: c.composerId,
          title: c.title,
          workspace: c.workspaceId,
          mode: c.mode,
          started_at: c.createdAt,
          ended_at: c.lastUpdatedAt,
          duration_ms:
            c.createdAt != null && c.lastUpdatedAt != null
              ? Math.max(0, c.lastUpdatedAt - c.createdAt)
              : null,
          source: "backfill",
        });
        sessions++;
      }
    })();

    console.log(
      `[backfill] ${statePath}: ${composers.length} composers — single-pass bubble scan…`,
    );

    const accByConv = new Map<string, Acc>();
    const getAcc = (id: string): Acc => {
      let a = accByConv.get(id);
      if (!a) {
        a = {
          model: null,
          exactIn: 0,
          exactOut: 0,
          estIn: 0,
          estOut: 0,
          sawExact: false,
          firstPrompt: null,
          toolSeen: new Set(),
        };
        accByConv.set(id, a);
      }
      return a;
    };

    const stmt = cursor.query(
      `SELECT key, value FROM cursorDiskKV
       WHERE key LIKE 'bubbleId:%' AND length(value) < ?`,
    );

    let scanned = 0;
    // One write txn for the whole scan — avoids lock churn vs hooks
    const write = metricsDb.transaction(() => {
      for (const row of stmt.iterate(MAX_VALUE_CHARS) as IterableIterator<{
        key: string;
        value: unknown;
      }>) {
        scanned++;
        if (scanned % PROGRESS_EVERY === 0) {
          console.log(
            `[backfill] … scanned ${scanned} bubbles, kept ${counts.bubbles}, tools ${counts.toolCalls}`,
          );
        }

        const ids = parseBubbleKey(row.key);
        if (!ids) continue;
        if (filterKnown && !knownIds.has(ids.conversationId)) continue;

        let data: Bubble;
        try {
          data = JSON.parse(decodeValue(row.value)) as Bubble;
        } catch {
          continue;
        }

        processBubble(
          metricsDb,
          ids.conversationId,
          ids.bubbleId,
          data,
          getAcc(ids.conversationId),
          counts,
        );
      }
    });
    write();
    // ponytail: skip second full-table COUNT for length>=cap; filter already drops them

    metricsDb.transaction(() => {
      for (const [conversationId, acc] of accByConv) {
        upsertSession(metricsDb, {
          conversation_id: conversationId,
          model: acc.model,
          first_prompt: acc.firstPrompt,
          source: "backfill",
        });
        if (!acc.sawExact && acc.estIn + acc.estOut > 0) estimatedSessions++;
      }
    })();

    console.log(
      `[backfill] done ${statePath}: scanned=${scanned} sessions=${sessions} bubbles=${counts.bubbles} tools=${counts.toolCalls} skipped_huge=${skippedHuge}`,
    );
  } finally {
    cursor.close();
  }

  if (rollup) recomputeAllRollups(metricsDb);
  return {
    sessions,
    bubbles: counts.bubbles,
    toolCalls: counts.toolCalls,
    estimatedSessions,
    path: statePath,
    paths: [statePath],
    skippedHuge,
  };
}

/** Backfill every discovered Cursor/Cur profile state.vscdb. */
export function backfillAllProfiles(metricsDb: Database): BackfillResult {
  const paths = discoverCursorStateDbs();
  if (!paths.length) {
    throw new Error(
      "No Cursor state.vscdb found under Application Support/Cursor|Cur or ~/.cursor|~/.cur",
    );
  }

  clearDerived(metricsDb);

  let sessions = 0;
  let bubbles = 0;
  let toolCalls = 0;
  let estimatedSessions = 0;
  let skippedHuge = 0;

  for (const path of paths) {
    const r = backfillFromCursor(metricsDb, path, { clear: false, rollup: false });
    sessions += r.sessions;
    bubbles += r.bubbles;
    toolCalls += r.toolCalls;
    estimatedSessions += r.estimatedSessions;
    skippedHuge += r.skippedHuge;
  }

  recomputeAllRollups(metricsDb);
  return {
    sessions,
    bubbles,
    toolCalls,
    estimatedSessions,
    path: paths.join("\n"),
    paths,
    skippedHuge,
  };
}
