# Plan: Per-Profile Export for `token-lens export`

## Problem

Today `token-lens export` only dumps the whole `sessions` or `session_rollups` table to CSV on stdout (src/cli.ts:181). The `profile` column exists on both tables (src/db/schema.ts:44,118) and is already filterable in the API (`/api/sessions?profile=.cursor`) and in `listSessions`/`getOverview`/`getDrivers` (src/db/queries.ts:384,409,476), but the CLI export ignores it. Users currently workaround via `sqlite3` or the running API.

## Goal

Add a `--profile` flag to the `export` command (and a few matching improvements) so users can dump per-profile session data straight from the CLI, matching the filtering semantics already used by the API.

Acceptance:

- `token-lens export --profile .cursor` writes only `.cursor` sessions.
- `token-lens export --profile .cursor sessions` filters sessions by profile.
- `token-lens export --profile .cursor session_rollups` filters rollups the same way.
- Omitting `--profile` keeps today's behavior (whole table).
- `--profile` validates against known profiles (warn / error if no rows match, but don't fail if the column exists).
- `--list-profiles` / `-L` shortcut prints known profiles from the DB and exits — useful for scripting.
- A small unit test covers the new filtering.

## Design

### CLI surface

Extend the existing `export` branch in src/cli.ts:181. New flags:

```
token-lens export [sessions|session_rollups] [--profile <name>] [--list-profiles]
```

- `[sessions|session_rollups]` — positional, defaults to `sessions` (today's behavior).
- `--profile <name>` — optional. Filters `WHERE profile = ?`. Empty string = no filter (same as omitting).
- `--list-profiles` / `-L` — calls `listProfiles(db)` and prints one per line, then exits. Useful before piping. Independent of `--profile`.

Update the usage block in src/cli.ts:22 to document the new flags.

### Implementation sketch

1. In src/cli.ts, parse `--profile` and `--list-profiles` early.
2. If `--list-profiles`, run `listProfiles(db)`, print, exit.
3. Otherwise, build the SQL:
   ```sql
   SELECT * FROM <table>[ WHERE profile = ?]
   ```
   Pass the optional profile as a bound parameter. Do NOT string-interpolate the profile value (cheaper, and prevents injection).
4. Reuse the existing CSV escape/header logic (src/cli.ts:191-202).
5. If no rows match, print header line only (or just empty output, matching today's "no rows" behavior — pick empty output to match today's behavior for parity).

### Why positional table arg, not `--table`

The current command takes the table as a positional arg (`export sessions`, `export session_rollups`). Keeping that avoids a breaking change. New `--profile` flag is purely additive.

### Edge cases

- Empty DB → empty stdout (already handled).
- Profile exists but zero rows → empty stdout after the WHERE clause. Consider printing a stderr warning, but default to silent for scripting.
- Profile column NULL on a row → those rows are excluded when any `--profile` is given (matches how `listSessions` already filters with `profile = ?`).
- Unknown profile string → returns zero rows. We do NOT validate against `listProfiles` because (a) profiles can appear after sync, and (b) it adds a needless round-trip. The `--list-profiles` flag is the way to discover valid values.

### README update

Add one short example to README.md under the existing "CLI" section:

```sh
token-lens export --profile .cursor sessions > cursor.csv
token-lens export --list-profiles
```

## Files to change

| File | Change |
|---|---|
| `src/cli.ts` | Add `--profile` and `--list-profiles` to `export` branch; update usage text. |
| `tests/cli-export.test.ts` | New test: seed two profiles, run export with `--profile`, assert only matching rows. |
| `README.md` | One-line addition to the CLI examples. |

No DB schema changes. No API changes. No new dependencies.

## Task breakdown

1. `feat(cli): add --profile and --list-profiles to export` — edits src/cli.ts:181-207, src/cli.ts:22-46 (usage). ~30 LOC.
2. `test: cover profile-export filtering` — new tests/cli-export.test.ts using bun:test. Seed an in-memory DB with two profiles, run the export logic via a small exported helper, assert row counts. ~50 LOC.
3. `docs: README example for --profile export` — README.md. ~5 lines.
4. `chore: run lint/typecheck/test` — `bun run` the relevant scripts (see Makefile).

## Verification

- `bun test tests/cli-export.test.ts` — passes.
- `bun run src/cli.ts export --list-profiles` — prints `.claude`, `.cursor`, `.opencode`.
- `bun run src/cli.ts export --profile .cursor sessions | head -1` — header line.
- `bun run src/cli.ts export --profile .cursor sessions | wc -l` — matches `SELECT COUNT(*) FROM sessions WHERE profile = '.cursor'` (minus 1 for header, or equal if no rows).
- `bun run src/cli.ts export sessions` — unchanged full-table behavior.

## Out of scope

- JSON / NDJSON output format. CSV stays the default.
- Adding `--since` / `--until` date filters. Separate tickets if desired.
- Exposing export via the API (e.g. `/api/export.csv`). API already returns JSON; users can pipe `curl .../api/sessions?profile=.cursor | jq`.
- Per-tool/per-model export beyond the existing `profile` column.
