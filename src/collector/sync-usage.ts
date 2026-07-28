import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { Database } from "bun:sqlite";
import { METRICS_DIR } from "../db/schema";
import { recomputeRollup, upsertSession, upsertTokenSnapshot } from "../db/queries";
import { invalidateOverviewCache } from "../db/overview-cache";

const API = "https://cursor.com/api/dashboard/get-filtered-usage-events";
const PAGE_SIZE = 100;
export const SESSION_TOKEN_FILE = join(METRICS_DIR, "session-token");
export const USAGE_PROFILES_FILE = join(METRICS_DIR, "usage-profiles.json");

type TokenUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
};

type UsageEvent = {
  timestamp?: string | number;
  model?: string;
  conversationId?: string;
  tokenUsage?: TokenUsage;
};

type UsagePage = {
  totalUsageEventsCount?: number;
  usageEventsDisplay?: UsageEvent[];
};

/** One Cursor account mapped to a local profile label (`.cur` / `.cursor`). */
export type UsageProfile = {
  name: string;
  /** WorkosCursorSessionToken value (`user_…::jwt`). */
  token: string;
  /** 0 = individual; company team numeric id. */
  teamId?: number;
  /** Optional: filter team usage to this numeric user id. */
  userId?: number;
};

export type SyncUsageOpts = {
  startDate?: number;
  endDate?: number;
  days?: number;
  teamId?: number;
  userId?: number;
  sessionToken?: string;
  profile?: string;
};

export type SyncUsageResult = {
  profile: string;
  pages: number;
  events: number;
  withCache: number;
  conversations: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

/** Cookie value may be URL-encoded (`%3A%3A`) or raw (`::`). */
function normalizeToken(raw: string): string {
  let t = raw.trim();
  if (t.toLowerCase().startsWith("workoscursorsessiontoken=")) {
    t = t.slice("workoscursorsessiontoken=".length);
  }
  try {
    if (t.includes("%")) t = decodeURIComponent(t);
  } catch {
    /* keep raw */
  }
  return t;
}

function cookieHeader(token: string, teamId?: number): string {
  const encoded = token.includes("::") ? token.replace(/::/g, "%3A%3A") : token;
  let c = `WorkosCursorSessionToken=${encoded}`;
  if (teamId && teamId > 0) c += `; team_id=${teamId}`;
  return c;
}

/** Map legacy CLI aliases → local profile labels. */
function normalizeProfileName(name: string): string {
  const n = name.trim();
  if (n === "personal" || n === "cur") return ".cur";
  if (n === "company" || n === "cursor") return ".cursor";
  return n;
}

function stateDbsForProfile(name: string): string[] {
  const home = homedir();
  if (name === ".cur") {
    return [
      join(home, ".cur/User/globalStorage/state.vscdb"),
      join(home, "Library/Application Support/Cur/User/globalStorage/state.vscdb"),
    ];
  }
  // Prefer Application Support/Cursor (real signed-in DB) over tiny ~/.cursor stub
  return [
    join(home, "Library/Application Support/Cursor/User/globalStorage/state.vscdb"),
    join(home, ".cursor/User/globalStorage/state.vscdb"),
    join(home, ".config/Cursor/User/globalStorage/state.vscdb"),
  ];
}

function jwtPayload(jwt: string): Record<string, unknown> | null {
  try {
    const part = jwt.split(".")[1];
    if (!part) return null;
    const pad = part + "=".repeat((4 - (part.length % 4)) % 4);
    return JSON.parse(Buffer.from(pad, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Read live desktop login from state.vscdb (`cursorAuth/accessToken`).
 * Works as WorkosCursorSessionToken when formatted `user_…::accessToken`.
 */
function readDesktopAuth(statePath: string): UsageProfile | null {
  if (!existsSync(statePath)) return null;
  let db: Database | null = null;
  try {
    db = new Database(`file:${statePath}?mode=ro`, { readonly: true, create: false });
    const access = db
      .query(`SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken'`)
      .get() as { value: string } | null;
    if (!access?.value?.startsWith("eyJ")) return null;

    const payload = jwtPayload(access.value);
    const sub = typeof payload?.sub === "string" ? payload.sub : "";
    const userId = sub.includes("|") ? sub.slice(sub.lastIndexOf("|") + 1) : sub;
    if (!userId.startsWith("user_")) return null;

    let teamId = 0;
    const teamRow = db
      .query(`SELECT value FROM ItemTable WHERE key = 'cursorAuth/cachedTeam'`)
      .get() as { value: string } | null;
    if (teamRow?.value) {
      try {
        const t = JSON.parse(teamRow.value) as { teamId?: number };
        if (t.teamId) teamId = Number(t.teamId);
      } catch {
        /* ignore */
      }
    }

    return {
      name: "", // filled by caller
      token: `${userId}::${access.value}`,
      teamId,
    };
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/** Auto-discover `.cur` / `.cursor` from local Cursor/Cur app logins. */
export function discoverDesktopUsageProfiles(): UsageProfile[] {
  const out: UsageProfile[] = [];
  for (const name of [".cur", ".cursor"] as const) {
    for (const path of stateDbsForProfile(name)) {
      const auth = readDesktopAuth(path);
      if (!auth) continue;
      out.push({ ...auth, name });
      break;
    }
  }
  return out;
}

function readManualProfiles(): UsageProfile[] {
  if (!existsSync(USAGE_PROFILES_FILE)) return [];
  try {
    const raw = JSON.parse(readFileSync(USAGE_PROFILES_FILE, "utf8")) as unknown;
    const list = Array.isArray(raw) ? raw : (raw as { profiles?: unknown })?.profiles;
    if (!Array.isArray(list)) return [];
    const out: UsageProfile[] = [];
    for (const p of list) {
      if (!p || typeof p !== "object") continue;
      const o = p as Record<string, unknown>;
      const token = String(o.token ?? o.sessionToken ?? "").trim();
      const name = normalizeProfileName(String(o.name ?? "").trim());
      if (!token || !name) continue;
      out.push({
        name,
        token: normalizeToken(token),
        teamId: o.teamId != null ? Number(o.teamId) : 0,
        userId: o.userId != null ? Number(o.userId) : undefined,
      });
    }
    return out;
  } catch (err) {
    console.error(`[usage] failed to parse ${USAGE_PROFILES_FILE}:`, err);
    return [];
  }
}

/**
 * Load usage accounts: desktop auth (state.vscdb) first; optional JSON only overlays teamId/userId
 * or supplies a profile when desktop login is missing.
 */
export function loadUsageProfiles(): UsageProfile[] {
  const byName = new Map<string, UsageProfile>();

  for (const p of discoverDesktopUsageProfiles()) byName.set(p.name, p);

  for (const p of readManualProfiles()) {
    const prev = byName.get(p.name);
    if (prev) {
      // Desktop token stays authoritative (browser cookies go stale; app token refreshes)
      byName.set(p.name, {
        ...prev,
        teamId: p.teamId ?? prev.teamId,
        userId: p.userId ?? prev.userId,
      });
    } else {
      byName.set(p.name, p);
    }
  }

  if (!byName.size) {
    const legacy = resolveLegacyToken();
    if (legacy) byName.set(".cur", { name: ".cur", token: legacy, teamId: 0 });
  }

  return [...byName.values()];
}

function resolveLegacyToken(explicit?: string): string | null {
  if (explicit?.trim()) return normalizeToken(explicit);
  const env = process.env.CURSOR_SESSION_TOKEN?.trim();
  if (env) return normalizeToken(env);
  if (existsSync(SESSION_TOKEN_FILE)) {
    const raw = readFileSync(SESSION_TOKEN_FILE, "utf8").trim();
    if (raw) return normalizeToken(raw);
  }
  return null;
}

/** True if at least one profile/token is configured. */
export function resolveSessionToken(explicit?: string): string | null {
  if (explicit?.trim()) return normalizeToken(explicit);
  return loadUsageProfiles()[0]?.token ?? null;
}

export function writeUsageProfiles(profiles: UsageProfile[]): void {
  mkdirSync(METRICS_DIR, { recursive: true });
  writeFileSync(USAGE_PROFILES_FILE, JSON.stringify(profiles, null, 2) + "\n", "utf8");
}

async function fetchPage(
  token: string,
  teamId: number,
  body: Record<string, unknown>,
): Promise<UsagePage> {
  const res = await fetch(API, {
    method: "POST",
    headers: {
      accept: "*/*",
      "content-type": "application/json",
      origin: "https://cursor.com",
      referer:
        teamId > 0
          ? "https://cursor.com/dashboard/usage"
          : "https://cursor.com/dashboard/usage",
      cookie: cookieHeader(token, teamId),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const authish =
      res.status === 401 ||
      res.status === 403 ||
      /authorize|not_authenticated|authkit/i.test(text);
    if (authish) {
      throw new Error(
        `session cookie rejected (HTTP ${res.status}) — re-copy WorkosCursorSessionToken from browser into ${USAGE_PROFILES_FILE}`,
      );
    }
    throw new Error(`usage API HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as UsagePage;
}

/**
 * Pull prompt-cache tokens from Cursor dashboard usage events (not in local vscdb)
 * and attach them via conversationId.
 *
 * Only cache fields are stored on `dash:*` snapshots (no in/out double-count).
 * Non-dash cache columns are cleared for touched conversations (dashboard wins).
 */
export async function syncUsageFromDashboard(
  db: Database,
  opts: SyncUsageOpts = {},
): Promise<SyncUsageResult> {
  const profileName = opts.profile ?? ".cur";
  const token = resolveLegacyToken(opts.sessionToken);
  if (!token) {
    throw new Error(
      `Missing session token for profile "${profileName}". Configure ${USAGE_PROFILES_FILE} or CURSOR_SESSION_TOKEN / ${SESSION_TOKEN_FILE}`,
    );
  }

  const end = opts.endDate ?? Date.now();
  const start = opts.startDate ?? end - (opts.days ?? 7) * 24 * 60 * 60 * 1000;
  const teamId = opts.teamId ?? 0;
  const userId = opts.userId;

  let page = 1;
  let total = Infinity;
  let events = 0;
  let withCache = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  const touched = new Set<string>();
  const sessionModels = new Map<string, string | null>();

  const apply = db.transaction((batch: UsageEvent[]) => {
    for (const ev of batch) {
      const cid = ev.conversationId?.trim();
      if (!cid) continue;
      const ts = Number(ev.timestamp);
      const tu = ev.tokenUsage ?? {};
      const cr = Number(tu.cacheReadTokens ?? 0) || 0;
      const cw = Number(tu.cacheWriteTokens ?? 0) || 0;
      if (!cr && !cw) continue;

      if (!touched.has(cid)) {
        db.run(
          `UPDATE token_snapshots SET cache_read_tokens = 0, cache_write_tokens = 0
           WHERE conversation_id = ? AND bubble_id NOT GLOB 'dash:*'`,
          [cid],
        );
        const row = db
          .query(`SELECT model, profile FROM sessions WHERE conversation_id = ?`)
          .get(cid) as { model: string | null; profile: string | null } | null;
        if (!row) {
          const stubModel = ev.model && ev.model !== "default" ? ev.model : null;
          upsertSession(db, {
            conversation_id: cid,
            model: stubModel,
            started_at: Number.isFinite(ts) ? ts : null,
            ended_at: Number.isFinite(ts) ? ts : null,
            source: "dashboard",
            profile: profileName,
          });
          sessionModels.set(cid, stubModel);
        } else {
          sessionModels.set(cid, row.model);
          // Fill profile only when missing (don't overwrite backfill attribution)
          if (!row.profile && profileName) {
            db.run(`UPDATE sessions SET profile = ? WHERE conversation_id = ? AND profile IS NULL`, [
              profileName,
              cid,
            ]);
          }
        }
        touched.add(cid);
      }

      const sessionModel = sessionModels.get(cid) ?? null;
      const model =
        ev.model && ev.model !== "default" ? ev.model : (sessionModel ?? ev.model ?? null);

      upsertTokenSnapshot(db, {
        conversation_id: cid,
        bubble_id: `dash:${Number.isFinite(ts) ? ts : events}`,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: cr,
        cache_write_tokens: cw,
        model,
        created_at: Number.isFinite(ts) ? ts : null,
        estimated: false,
      });
      withCache++;
      cacheReadTokens += cr;
      cacheWriteTokens += cw;
    }
  });

  while ((page - 1) * PAGE_SIZE < total) {
    const body: Record<string, unknown> = {
      teamId,
      startDate: String(start),
      endDate: String(end),
      page,
      pageSize: PAGE_SIZE,
    };
    if (userId != null && Number.isFinite(userId)) body.userId = userId;

    const data = await fetchPage(token, teamId, body);
    const batch = data.usageEventsDisplay ?? [];
    total = data.totalUsageEventsCount ?? batch.length;
    events += batch.length;
    apply(batch);
    if (!batch.length) break;
    page++;
  }

  for (const cid of touched) recomputeRollup(db, cid);

  return {
    profile: profileName,
    pages: page - 1,
    events,
    withCache,
    conversations: touched.size,
    cacheReadTokens,
    cacheWriteTokens,
  };
}

/** Sync one or all configured profiles (`name` = `.cur` | `.cursor` | `all`). */
export async function syncUsageProfiles(
  db: Database,
  opts: { days?: number; profile?: string } = {},
): Promise<SyncUsageResult[]> {
  const all = loadUsageProfiles().map((p) => ({
    ...p,
    name: normalizeProfileName(p.name),
  }));
  if (!all.length) {
    throw new Error(
      `No usage profiles. Sign in to Cursor/Cur locally, or set ${USAGE_PROFILES_FILE}.`,
    );
  }
  const want =
    opts.profile && opts.profile !== "all" ? normalizeProfileName(opts.profile) : null;
  const selected = want ? all.filter((p) => p.name === want) : all;
  if (!selected.length) {
    throw new Error(
      `Unknown profile "${opts.profile}". Known: ${all.map((p) => p.name).join(", ")}`,
    );
  }

  const results: SyncUsageResult[] = [];
  for (const p of selected) {
    try {
      const r = await syncUsageFromDashboard(db, {
        days: opts.days ?? 7,
        teamId: p.teamId ?? 0,
        userId: p.userId,
        sessionToken: p.token,
        profile: p.name,
      });
      results.push(r);
    } catch (err) {
      console.error(`[usage:${p.name}] failed:`, err instanceof Error ? err.message : err);
    }
  }
  if (!results.length) {
    throw new Error(
      `All usage profile syncs failed (${selected.map((p) => p.name).join(", ")}).`,
    );
  }
  invalidateOverviewCache(db);
  return results;
}
