import { cursorTool } from "./cursor";
import { claudeCodeTool } from "./claude-code";
import { openCodeTool } from "./opencode";
import type { Tool } from "./types";

const registry: Tool[] = [];

export function registerTool(tool: Tool): void {
  registry.push(tool);
}

export function getTool(id: string): Tool | undefined {
  return registry.find((t) => t.id === id);
}

export function listTools(): Tool[] {
  return [...registry];
}

// ponytail: register at import time so callers don't have to wire imports. Order matters only for listTools().
registerTool(cursorTool);
registerTool(claudeCodeTool);
registerTool(openCodeTool);
