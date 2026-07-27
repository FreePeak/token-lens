/** LeanKG / graph MCP tool name patterns (Cursor stores mcp-<server>-<tool>). */
export const LEANKG_TOOL_RE = /(?:^|[-_])leankg(?:[-_]|$)|(?:^|[-_])(?:concept_search|semantic_search|get_overview_context|get_context|search_code|query_graph|find_function|mcp_status|get_impact_radius|get_callers|get_dependencies)/i;

/** Expensive filesystem search tools that LeanKG is meant to replace. */
export const SEARCH_TOOL_RE =
  /ripgrep|grep|glob_file_search|file_search|list_dir_v2|list_dir|Codebase_Search|codebase_search/i;

export const READ_TOOL_RE = /read_file|Read$|^Read$|TabRead|readFile/i;

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
