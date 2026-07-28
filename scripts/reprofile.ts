import { existsSync } from "fs";
import { Database } from "bun:sqlite";
import { cursorStateDbCandidates, openMetricsDb, profileFromStatePath } from "../src/db/schema";

const apply = Bun.argv.includes("--apply");
const metrics = openMetricsDb();
const candidates = cursorStateDbCandidates().filter(existsSync);
const owners = new Map<string, Set<string>>();

for (const statePath of candidates) {
  let db: Database | null = null;
  try {
    db = new Database(`file:${statePath}?mode=ro`, { readonly: true, create: false });
    const table = db.query(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='composerHeaders'`).get();
    if (!table) continue;
    const profile = profileFromStatePath(statePath);
    for (const row of db.query(`SELECT composerId FROM composerHeaders`).all() as Array<{ composerId: string }>) {
      const set = owners.get(row.composerId) ?? new Set<string>();
      set.add(profile);
      owners.set(row.composerId, set);
    }
  } catch {
    // Ignore unavailable or incompatible state databases.
  } finally {
    db?.close();
  }
}

const rows = metrics.query(`SELECT conversation_id, profile FROM sessions WHERE profile = '.cur'`).all() as Array<{ conversation_id: string; profile: string }>;
const changes = rows.filter((row) => owners.get(row.conversation_id)?.size === 1 && owners.get(row.conversation_id)?.has(".cursor"));
const ambiguous = rows.length - changes.length;
console.log(`Candidates: ${candidates.length} state DBs`);
console.log(`Rows scanned: ${rows.length}`);
console.log(`Rows to reprofile: ${changes.length}`);
console.log(`Ambiguous/unresolved: ${ambiguous}`);
if (!apply) {
  console.log("Dry run only. Re-run with --apply to mutate metrics.db.");
  metrics.close();
  process.exit(0);
}

metrics.transaction(() => {
  for (const row of changes) {
    metrics.run(`UPDATE sessions SET profile = '.cursor' WHERE conversation_id = ?`, row.conversation_id);
    metrics.run(`UPDATE session_rollups SET profile = '.cursor' WHERE conversation_id = ?`, row.conversation_id);
  }
})();
console.log(`Applied: ${changes.length} sessions and matching rollups`);
metrics.close();
