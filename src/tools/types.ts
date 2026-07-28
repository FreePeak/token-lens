import type { Database } from "bun:sqlite";

/**
 * A tool = an AI coding assistant whose data we want to track.
 *
 * Cursor is the first supported tool. Claude Code and OpenCode are stubs
 * registered so the CLI surface (profile filter, dashboard) can name them
 * without crashing; their `backfill` / `installHooks` throw with a clear
 * "not yet implemented" message.
 */
export type Tool = {
  /** Stable id used in profiles, DB filters, CLI flags. e.g. "cursor", "claude-code", "opencode". */
  id: string;
  /** Human display name shown in the dashboard header. e.g. "Cursor", "Claude Code", "OpenCode". */
  displayName: string;
  /** Filesystem hints for finding this tool's storage. Used by `profileFromStatePath`. */
  statePathHints: string[];
  /** Backfill one tool's local state into the metrics DB. */
  backfill: (metricsDb: Database, opts: { resume: boolean; rollup: boolean }) => Promise<{ changed: number; bubbles: number; toolCalls: number }>;
  /** Install live hooks for this tool. Returns null if no hook integration (e.g. protocol-based). */
  installHooks?: (projectRoot: string) => { hooksJson: string; script: string };
  /** Whether this tool has a usage-events API to sync cache tokens. */
  supportsUsageSync?: boolean;
  /** Run usage sync, if supported. */
  syncUsage?: (metricsDb: Database, opts: { days?: number; profile?: string }) => Promise<unknown>;
};
