import { afterEach, beforeEach, expect, test } from "bun:test";
import { exportTableCsv, parseExportArgs } from "../src/cli";
import { recomputeRollup, upsertSession } from "../src/db/queries";
import { openMetricsDb } from "../src/db/schema";

let db: ReturnType<typeof openMetricsDb>;

beforeEach(() => {
  db = openMetricsDb(":memory:");
  upsertSession(db, {
    conversation_id: "cursor-session",
    title: "Cursor session",
    profile: ".cursor",
  });
  upsertSession(db, {
    conversation_id: "claude-session",
    title: "Claude session",
    profile: ".claude",
  });
  recomputeRollup(db, "cursor-session");
  recomputeRollup(db, "claude-session");
});

afterEach(() => {
  db.close();
});

test("parses export flags before or after the table", () => {
  expect(parseExportArgs([]).table).toBe("sessions");
  expect(parseExportArgs(["--profile", ".cursor", "sessions"])).toEqual({
    table: "sessions",
    profile: ".cursor",
    listProfiles: false,
  });
  expect(parseExportArgs(["sessions", "--profile", ".cursor"])).toEqual({
    table: "sessions",
    profile: ".cursor",
    listProfiles: false,
  });
  expect(parseExportArgs(["session_rollups", "--profile", ".cursor"])).toEqual({
    table: "session_rollups",
    profile: ".cursor",
    listProfiles: false,
  });
  expect(parseExportArgs(["-L"]).listProfiles).toBe(true);
  expect(parseExportArgs(["--list-profiles"]).listProfiles).toBe(true);
});

test("filters sessions and session_rollups by profile", () => {
  for (const table of ["sessions", "session_rollups"] as const) {
    const csv = exportTableCsv(db, table, ".cursor");
    expect(csv).toContain("cursor-session");
    expect(csv).not.toContain("claude-session");
  }
});

test("an empty profile does not filter and empty results remain a blank line", () => {
  const csv = exportTableCsv(db, "sessions", "");
  expect(csv).toContain("cursor-session");
  expect(csv).toContain("claude-session");
  expect(exportTableCsv(db, "sessions", ".missing")).toBe("\n");
});
