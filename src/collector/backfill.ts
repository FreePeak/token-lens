import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import {
  insertToolCall,
  recomputeAllRollups,
  recomputeRollups,
  upsertSession,
  upsertTokenSnapshot,
  upsertTurn,
} from "../db/queries";
import { invalidateOverviewCache } from "../db/overview-cache";
import { discoverCursorStateDbs, profileFromStatePath } from "../db/schema";
import { charsToTokens, contentChars, normalizeToolLabel } from "../shared/tools";

const MAX_VALUE_CHARS = 2_000_000;
const PROGRESS_EVERY = 5_000;
/** Above this many changed composers, one full bubble pass beats N range scans. */
const FULL_SCAN_CHANGED_THRESHOLD = 80;
const BACKFILL_LOCK = join(homedir(), ".cursor-metrics", "backfill.lock");

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
  changed: number;
};

function clearDerived(metricsDb: Database): void {
  metricsDb.exec(`
    DELETE FROM tool_calls;
    DELETE FROM turns;
    DELETE FROM token_snapshots WHERE bubble_id NOT GLOB 'dash:*';
    DELETE FROM session_rollups;
    DELETE FROM sessions;
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
  lastPrompt: string | null;
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
  if (isUser) {
    const raw = (data.text ?? data.richText ?? "").trim().replace(/\s+/g, " ");
    if (raw) {
      acc.lastPrompt = raw.slice(0, 240);
      if (!acc.firstPrompt) acc.firstPrompt = acc.lastPrompt;
    }
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
      // only user bubbles carry text; UI fill-forwards by created_at (scan order ≠ chrono)
      prompt: isUser ? acc.lastPrompt : null,
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

function knownBackfilledAt(
  metricsDb: Database,
  profile: string,
): Map<string, number | null> {
  const rows = metricsDb
    .query(`SELECT conversation_id, last_backfilled_at FROM sessions WHERE profile = ?`)
    .all(profile) as Array<{ conversation_id: string; last_backfilled_at: number | null }>;
  return new Map(rows.map((r) => [r.conversation_id, r.last_backfilled_at]));
}

function wipeConversationDerived(metricsDb: Database, ids: string[]): void {
  if (!ids.length) return;
  const delIn = (table: string, extraWhere = "") => {
    const chunk = 400;
    for (let i = 0; i < ids.length; i += chunk) {
      const part = ids.slice(i, i + chunk);
      const ph = part.map(() => "?").join(",");
      metricsDb.run(`DELETE FROM ${table} WHERE conversation_id IN (${ph})${extraWhere}`, part);
    }
  };
  delIn("tool_calls");
  delIn("turns");
  delIn("token_snapshots", " AND bubble_id NOT GLOB 'hook:*' AND bubble_id NOT GLOB 'dash:*'");
  // session_rollups overwritten by recomputeRollups — never delete
}

function scanBubblesForConversations(
  cursor: Database,
  metricsDb: Database,
  conversationIds: Set<string>,
  mode: "full" | "per-id",
): { scanned: number; bubbles: number; toolCalls: number; estimatedSessions: number } {
  const counts = { bubbles: 0, toolCalls: 0 };
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
        lastPrompt: null,
        toolSeen: new Set(),
      };
      accByConv.set(id, a);
    }
    return a;
  };

  let scanned = 0;

  const handleRow = (key: string, value: unknown) => {
    scanned++;
    if (scanned % PROGRESS_EVERY === 0) {
      console.log(
        `[backfill] … scanned ${scanned} bubbles, kept ${counts.bubbles}, tools ${counts.toolCalls}`,
      );
    }
    const ids = parseBubbleKey(key);
    if (!ids || !conversationIds.has(ids.conversationId)) return;

    let data: Bubble;
    try {
      data = JSON.parse(decodeValue(value)) as Bubble;
    } catch {
      return;
    }
    processBubble(metricsDb, ids.conversationId, ids.bubbleId, data, getAcc(ids.conversationId), counts);
  };

  const write = metricsDb.transaction(() => {
    if (mode === "full") {
      const stmt = cursor.query(
        `SELECT key, value FROM cursorDiskKV
         WHERE key LIKE 'bubbleId:%' AND length(value) < ?`,
      );
      for (const row of stmt.iterate(MAX_VALUE_CHARS) as IterableIterator<{
        key: string;
        value: unknown;
      }>) {
        handleRow(row.key, row.value);
      }
    } else {
      const stmt = cursor.query(
        `SELECT key, value FROM cursorDiskKV
         WHERE key LIKE $prefix AND length(value) < $max`,
      );
      for (const id of conversationIds) {
        for (const row of stmt.iterate({
          $prefix: `bubbleId:${id}:%`,
          $max: MAX_VALUE_CHARS,
        }) as IterableIterator<{ key: string; value: unknown }>) {
          handleRow(row.key, row.value);
        }
      }
    }
  });
  write();

  let estimatedSessions = 0;
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

  return { scanned, bubbles: counts.bubbles, toolCalls: counts.toolCalls, estimatedSessions };
}

/** Single-pass or per-composer scan of one state.vscdb. */
export async function backfillFromCursor(
  metricsDb: Database,
  statePath: string,
  opts: { clear?: boolean; rollup?: boolean; resume?: boolean } = {},
): Promise<BackfillResult> {
  const clear = opts.clear === true;
  const rollup = opts.rollup !== false;
  const resume = opts.resume === true && !clear;
  const profile = profileFromStatePath(statePath);
  const cursor = openCursorDb(statePath);
  let sessions = 0;
  let estimatedSessions = 0;
  let skippedHuge = 0;
  let bubbles = 0;
  let toolCalls = 0;
  let scanned = 0;
  let changedCount = 0;

  try {
    if (clear) clearDerived(metricsDb);

    const composers = loadComposers(cursor);
    const prior = resume ? knownBackfilledAt(metricsDb, profile) : new Map<string, number | null>();

    const changed: ComposerMeta[] = [];
    let skippedUnchanged = 0;
    for (const c of composers) {
      // check if session exists in metrics DB
      let exists = false;
      if (resume) {
        const row = metricsDb
          .query(`SELECT 1 AS ok FROM sessions WHERE conversation_id = ?`)
          .get(c.composerId) as { ok: number } | null;
        exists = !!row;
      }
      if (resume && exists) {
        const prev = prior.get(c.composerId);
        // skip only when we already imported this composer and lastUpdatedAt hasn't moved
        if (
          prev !== undefined &&
          prev != null &&
          c.lastUpdatedAt != null &&
          c.lastUpdatedAt <= prev
        ) {
          skippedUnchanged++;
          continue;
        }
      }
      changed.push(c);
    }
    changedCount = changed.length;

    metricsDb.transaction(() => {
      for (const c of changed) {
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
          profile,
        });
        sessions++;
      }
    })();

    if (!changed.length) {
      console.log(
        `[backfill] ${profile}: ${composers.length} composers, 0 changed — skip bubble scan`,
      );
      return {
        sessions,
        bubbles: 0,
        toolCalls: 0,
        estimatedSessions: 0,
        path: statePath,
        paths: [statePath],
        skippedHuge: 0,
        changed: 0,
      };
    }

    const changedIds = changed.map((c) => c.composerId);
    // re-import tools/tokens for changed only (tool_calls have no upsert key)
    if (resume) wipeConversationDerived(metricsDb, changedIds);

    const mode =
      !resume || changed.length >= FULL_SCAN_CHANGED_THRESHOLD || changed.length === composers.length
        ? "full"
        : "per-id";
    const targetIds = new Set(changedIds);

    console.log(
      `[backfill] ${profile}: ${composers.length} composers, ${changed.length} changed` +
        (skippedUnchanged ? `, ${skippedUnchanged} skipped` : "") +
        ` — ${mode} bubble scan…`,
    );

    const r = scanBubblesForConversations(cursor, metricsDb, targetIds, mode);
    scanned = r.scanned;
    bubbles = r.bubbles;
    toolCalls = r.toolCalls;
    estimatedSessions = r.estimatedSessions;

    // stamp last_backfilled_at on changed composers after successful bubble scan
    metricsDb.transaction(() => {
      for (const c of changed) {
        upsertSession(metricsDb, {
          conversation_id: c.composerId,
          source: "backfill",
          profile,
          last_backfilled_at: c.lastUpdatedAt,
        });
      }
    })();

    console.log(
      `[backfill] done ${profile}: scanned=${scanned} sessions=${sessions} bubbles=${bubbles} tools=${toolCalls} skipped_huge=${skippedHuge}`,
    );

    if (rollup) {
      if (resume) await recomputeRollups(metricsDb, changedIds);
      else await recomputeAllRollups(metricsDb);
    }
  } finally {
    cursor.close();
  }

  return {
    sessions,
    bubbles,
    toolCalls,
    estimatedSessions,
    path: statePath,
    paths: [statePath],
    skippedHuge,
    changed: changedCount,
  };
}

/** Try to acquire pid-file lock. Returns cleanup fn if acquired, null if another process holds it. */
function acquireBackfillLock(): (() => void) | null {
  const dir = join(homedir(), ".cursor-metrics");
  mkdirSync(dir, { recursive: true });
  if (existsSync(BACKFILL_LOCK)) {
    const stale = readFileSync(BACKFILL_LOCK, "utf-8").trim();
    const pid = Number(stale);
    if (Number.isFinite(pid) && pid > 0) {
      try {
        process.kill(pid, 0); // signal 0 = existence check
        // process is alive — another backfill running
        return null;
      } catch {
        // process dead — steal lock
      }
    }
  }
  writeFileSync(BACKFILL_LOCK, String(process.pid), "utf-8");
  return () => {
    try { unlinkSync(BACKFILL_LOCK); } catch { /* best-effort */ }
  };
}

/**
 * Incremental backfill: skip composers whose last_backfilled_at hasn't moved;
 * only re-scan bubbles for new/changed sessions.
 */
export async function backfillIncrementalAll(metricsDb: Database): Promise<BackfillResult> {
  const unlock = acquireBackfillLock();
  if (!unlock) {
    console.log("[backfill] skip — another backfill process is running");
    return { sessions: 0, bubbles: 0, toolCalls: 0, estimatedSessions: 0, path: "", paths: [], skippedHuge: 0, changed: 0 };
  }

  try {
    const paths = discoverCursorStateDbs();
    let sessions = 0;
    let bubbles = 0;
    let toolCalls = 0;
    let estimatedSessions = 0;
    let skippedHuge = 0;
    let changed = 0;

    for (const path of paths) {
      const r = await backfillFromCursor(metricsDb, path, { clear: false, rollup: true, resume: true });
      sessions += r.sessions;
      bubbles += r.bubbles;
      toolCalls += r.toolCalls;
      estimatedSessions += r.estimatedSessions;
      skippedHuge += r.skippedHuge;
      changed += r.changed;
    }

    invalidateOverviewCache(metricsDb);

    return {
      sessions,
      bubbles,
      toolCalls,
      estimatedSessions,
      path: paths.join("\n"),
      paths,
      skippedHuge,
      changed,
    };
  } finally {
    unlock();
  }
}

/** Full wipe + import every discovered Cursor/Cur profile state.vscdb. */
export async function backfillAllProfiles(metricsDb: Database): Promise<BackfillResult> {
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
  let changed = 0;

  for (const path of paths) {
    const r = await backfillFromCursor(metricsDb, path, { clear: false, rollup: false, resume: false });
    sessions += r.sessions;
    bubbles += r.bubbles;
    toolCalls += r.toolCalls;
    estimatedSessions += r.estimatedSessions;
    skippedHuge += r.skippedHuge;
    changed += r.changed;
  }

  await recomputeAllRollups(metricsDb);
  invalidateOverviewCache(metricsDb);
  return {
    sessions,
    bubbles,
    toolCalls,
    estimatedSessions,
    path: paths.join("\n"),
    paths,
    skippedHuge,
    changed,
  };
}
