import { homedir } from "os";
import { join } from "path";
import { backfillAgent } from "../collector/agent-backfill";
import type { Tool } from "./types";

/**
 * Agents whose only on-disk artefact is one JSONL session log per session.
 * xdev, omp and pi share the log contract in `collector/agent-session.ts`,
 * so one factory covers all three.
 */
function agentTool(
  id: "xdev" | "omp" | "pi",
  displayName: string,
  segments: string[],
): Tool {
  const sessionsDir = join(homedir(), ...segments);
  return {
    id,
    displayName,
    statePathHints: [segments[0]!],
    async backfill(metricsDb) {
      const r = await backfillAgent(metricsDb, {
        profile: `.${id}`,
        kind: id,
        displayName,
        sessionsDir,
      });
      return { changed: r.sessions, bubbles: 0, toolCalls: r.toolCalls };
    },
  };
}

export const xdevTool = agentTool("xdev", "xdev", [".xdev", "agent", "sessions"]);
export const ompTool = agentTool("omp", "omp", [".omp", "agent", "sessions"]);
export const piTool = agentTool("pi", "pi", [".pi", "agent", "sessions"]);
