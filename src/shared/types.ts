/** Alamofire-style session rollup metrics. */
export type SessionRollup = {
  conversation_id: string;
  title: string | null;
  workspace: string | null;
  workspace_path: string | null;
  model: string | null;
  mode: string | null;
  started_at: number | null;
  ended_at: number | null;
  duration_ms: number | null;
  num_turns: number;
  tool_calls: number;
  file_reads: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  total_cost_usd: number;
  tokens_estimated?: number;
  used_leankg?: number;
  leankg_calls?: number;
  search_calls?: number;
  cache_reads?: number;
  cache_writes?: number;
  first_prompt?: string | null;
  profile: string | null;
};

export type OverviewStats = {
  sessions: number;
  num_turns: number;
  tool_calls: number;
  file_reads: number;
  cache_reads?: number;
  cache_writes?: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  total_cost_usd: number;
};

export type DriverRow = {
  key: string;
  sessions: number;
  tool_calls: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  total_cost_usd: number;
};

export type SessionDetail = SessionRollup & {
  turns: Array<{
    generation_id: string;
    status: string | null;
    started_at: number | null;
    ended_at: number | null;
  }>;
  tools: Array<{
    tool_name: string;
    count: number;
    failures: number;
  }>;
  token_snapshots: Array<{
    bubble_id: string;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens?: number;
    cache_write_tokens?: number;
    context_tokens: number | null;
    model: string | null;
    created_at: number | null;
    prompt?: string | null;
  }>;
  context_events: Array<{
    id: number;
    context_tokens: number | null;
    context_usage_percent: number | null;
    context_window_size: number | null;
    created_at: number | null;
  }>;
};

export type HookPayload = {
  hook_event_name?: string;
  conversation_id?: string;
  session_id?: string;
  generation_id?: string;
  model?: string;
  model_id?: string;
  workspace_roots?: string[];
  status?: string;
  reason?: string;
  duration_ms?: number;
  tool_name?: string;
  tool_input?: unknown;
  tool_output?: unknown;
  duration?: number;
  context_tokens?: number;
  context_usage_percent?: number;
  context_window_size?: number;
  text?: string;
  composer_mode?: string;
  is_background_agent?: boolean;
  /** Billed tokens from afterAgentResponse (Cursor hook schema). */
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  [key: string]: unknown;
};
