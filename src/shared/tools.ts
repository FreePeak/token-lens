/** LeanKG / graph MCP tool name patterns (Cursor stores mcp-<server>-<tool>). */
const LEANKG_TOOL_RE =
  /(?:^|[-_])leankg(?:[-_]|$)|(?:^|[-_])(?:concept_search|semantic_search|get_overview_context|get_context|search_code|query_graph|find_function|mcp_status|get_impact_radius|get_callers|get_dependencies)/i;

/** Expensive filesystem search tools that LeanKG is meant to replace. */
export const SEARCH_TOOL_RE =
  /ripgrep|grep|glob_file_search|file_search|list_dir_v2|list_dir|Codebase_Search|codebase_search/i;

const READ_TOOL_RE = /read_file|Read$|^Read$|TabRead|readFile/i;

export const TERMINAL_TOOL_RE = /run_terminal_command|Shell$|^Shell$|Bash$|execute_command/i;

export function isLeanKgTool(name: string): boolean {
  return /leankg/i.test(name) || LEANKG_TOOL_RE.test(name);
}

export function isSearchTool(name: string): boolean {
  return SEARCH_TOOL_RE.test(name);
}

export function isReadTool(name: string): boolean {
  return READ_TOOL_RE.test(name);
}

/** ~4 chars/token heuristic when Cursor leaves tokenCount at 0. */
export function charsToTokens(chars: number): number {
  if (chars <= 0) return 0;
  return Math.max(1, Math.ceil(chars / 4));
}

export function contentChars(parts: Array<string | null | undefined>): number {
  let n = 0;
  for (const p of parts) {
    if (typeof p === "string") n += p.length;
  }
  return n;
}

function parseJsonish(s: string | undefined | null): Record<string, unknown> | null {
  if (!s || typeof s !== "string") return null;
  try {
    const v = JSON.parse(s) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** First executable token from a shell command (skips env assignments / sudo). */
export function shellHead(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) return "shell";
  // Split on && / ; / | and take first segment
  const first = trimmed.split(/\s*(?:&&|\|\||;|\|)\s*/)[0] ?? trimmed;
  const tokens = first.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  for (const t of tokens) {
    if (t.includes("=") && !t.startsWith("-")) continue; // FOO=bar
    const bare = t.replace(/^['"]|['"]$/g, "");
    if (bare === "sudo" || bare === "env" || bare === "command" || bare === "time") continue;
    if (bare === "cd") return "cd";
    const base = bare.split("/").pop() ?? bare;
    return base.slice(0, 40) || "shell";
  }
  return "shell";
}

/**
 * Specific tool attribution for waste review.
 * Terminal → `terminal:<cmd>`; LeanKG MCP → `leankg:<tool>`; other MCP → `mcp:<server>/<tool>`.
 */
export function normalizeToolLabel(
  name: string,
  opts?: { rawArgs?: string | null; params?: string | null },
): string {
  const n = name.trim();
  if (!n) return "unknown";

  if (TERMINAL_TOOL_RE.test(n)) {
    const fromParams = parseJsonish(opts?.params ?? null);
    const fromArgs = parseJsonish(opts?.rawArgs ?? null);
    const cmd =
      (typeof fromParams?.command === "string" && fromParams.command) ||
      (typeof fromArgs?.command === "string" && fromArgs.command) ||
      (typeof opts?.rawArgs === "string" && !opts.rawArgs.startsWith("{") ? opts.rawArgs : "") ||
      "";
    return `terminal:${shellHead(cmd)}`;
  }

  // mcp-leankg-semantic_search → leankg:semantic_search
  const leankg = /^mcp[-_]leankg[-_](.+)$/i.exec(n);
  if (leankg) return `leankg:${leankg[1]}`;

  // mcp-<server>-<tool> (server may contain hyphens: mcp-db-mcp-server-query_be-merchant)
  const mcp = /^mcp-(.+)$/i.exec(n);
  if (mcp) {
    const rest = mcp[1];
    // Prefer last segment after known server prefixes when tool has underscore start
    const parts = rest.split("-");
    // Find first part that looks like a tool (contains _ or is last)
    let splitAt = -1;
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].includes("_") || /^[a-z]+_[a-z]/i.test(parts.slice(i).join("-"))) {
        splitAt = i;
        break;
      }
    }
    if (splitAt > 0) {
      const server = parts.slice(0, splitAt).join("-");
      const tool = parts.slice(splitAt).join("-");
      return `mcp:${server}/${tool}`;
    }
    return `mcp:${rest}`;
  }

  return n;
}
