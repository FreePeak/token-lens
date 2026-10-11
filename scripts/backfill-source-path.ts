#!/usr/bin/env bun
// One-shot: populate `sessions.source_path` for legacy rows where it's null.
// Cursor: scan the right state.vscdb for matching composerId.
// Claude Code: derive jsonlPath from `~/.claude/projects/<workspace>/<id>.jsonl`.
// OpenCode: derive `<opencode.db>#session/<id>` from the discovered db.
//
// Reads ~/.token-lens/metrics.db (the path openMetricsDb uses).

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  METRICS_DB_PATH,
  cursorStateDbCandidates,
  profileFromStatePath,
  openMetricsDb,
} from "../src/db/schema";

type Counts = { cursor: number; claude: number; opencode: number; skipped: number };

function patch(): Counts {
  const counts: Counts = { cursor: 0, claude: 0, opencode: 0, skipped: 0 };
  const db = openMetricsDb(METRICS_DB_PATH);

  // Cursor — for each discovered state.vscdb, set source_path for rows whose
  // profile matches and composerId is in that DB.
  for (const statePath of cursorStateDbCandidates()) {
    if (!existsSync(statePath)) continue;
    const profile = profileFromStatePath(statePath);
    const rows = db
      .query(
        `SELECT conversation_id FROM sessions
          WHERE profile = ?`,
      )
      .all(profile) as Array<{ conversation_id: string }>;
    if (!rows.length) continue;
    const ids = new Set(rows.map((r) => r.conversation_id));
    const update = db.prepare(
      `UPDATE sessions SET source_path = ? WHERE conversation_id = ?`,
    );
    let n = 0;
    const cursor = new Database(`file:${statePath}?mode=ro`, {
      readonly: true,
      create: false,
    });
    try {
      const tx = db.transaction((cid: string) => {
        update.run(statePath, cid);
        n++;
      });
      for (const id of ids) tx(id);
    } finally {
      cursor.close();
    }
    counts.cursor += n;
  }

  // Claude Code — workspace IS the encoded cwd; jsonl = <projects>/<enc>/<id>.jsonl.
  const claudeHome = join(homedir(), ".claude");
  const projectsDir = join(claudeHome, "projects");
  if (existsSync(projectsDir)) {
    const upd = db.prepare(
      `UPDATE sessions SET source_path = ?
        WHERE conversation_id = ? AND profile = ?`,
    );
    const rows = db
      .query(
        `SELECT conversation_id, workspace FROM sessions
          WHERE profile = ?`,
      )
      .all(".claude") as Array<{ conversation_id: string; workspace: string | null }>;
    let n = 0;
    const tx = db.transaction(() => {
      for (const r of rows) {
        if (!r.workspace) continue;
        const path = join(projectsDir, r.workspace, `${r.conversation_id}.jsonl`);
        if (!existsSync(path)) continue; // skip — file may have been deleted
        upd.run(path, r.conversation_id, ".claude");
        n++;
      }
    });
    tx();
    counts.claude = n;
  }

  // OpenCode — single db per discovered home; same suffix scheme as backfill.
  for (const home of [
    join(homedir(), ".local", "share", "opencode"),
    join(homedir(), ".config", "opencode"),
    join(homedir(), ".config", "OpenCode"),
  ]) {
    const dbPath = join(home, "opencode.db");
    if (!existsSync(dbPath)) continue;
    const rows = db
      .query(
        `SELECT conversation_id FROM sessions
          WHERE profile = ?`,
      )
      .all(".opencode") as Array<{ conversation_id: string }>;
    const upd = db.prepare(
      `UPDATE sessions SET source_path = ? WHERE conversation_id = ?`,
    );
    let n = 0;
    const tx = db.transaction(() => {
      for (const r of rows) upd.run(dbPath, r.conversation_id);
      n += rows.length;
    });
    tx();
    counts.opencode += n;
  }

  counts.skipped =
    (db
      .query(`SELECT COUNT(*) AS n FROM sessions WHERE source_path IS NULL`)
      .get() as { n: number }).n;

  return counts;
}

const c = patch();
console.log(JSON.stringify(c, null, 2));
