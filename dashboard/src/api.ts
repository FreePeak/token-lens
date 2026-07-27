export type SessionRollup = {
  conversation_id: string;
  title: string | null;
  workspace: string | null;
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
  first_prompt?: string | null;
};

export type OverviewStats = {
  sessions: number;
  num_turns: number;
  tool_calls: number;
  file_reads: number;
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
  tools: Array<{ tool_name: string; count: number; failures: number }>;
  token_snapshots: Array<{
    bubble_id: string;
    input_tokens: number;
    output_tokens: number;
    context_tokens: number | null;
    model: string | null;
    created_at: number | null;
  }>;
};

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${res.status} ${path}`);
  return res.json() as Promise<T>;
}

export const api = {
  overview: (days?: number) =>
    get<OverviewStats>(`/api/overview${days ? `?days=${days}` : ""}`),
  sessions: (days?: number) =>
    get<SessionRollup[]>(`/api/sessions${days ? `?days=${days}` : ""}`),
  session: (id: string) => get<SessionDetail>(`/api/sessions/${encodeURIComponent(id)}`),
  drivers: (by: "tool" | "model" | "workspace", days?: number) =>
    get<DriverRow[]>(`/api/drivers?by=${by}${days ? `&days=${days}` : ""}`),
};

export function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

export function fmtCost(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n < 0.01 && n > 0) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

export function fmtDuration(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return `${m}m${rem ? `${rem}s` : ""}`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

export function shortTitle(s: SessionRollup): string {
  if (s.title?.trim()) return s.title.trim().slice(0, 80);
  if (s.workspace) {
    const parts = s.workspace.replace(/\\/g, "/").split("/");
    return parts[parts.length - 1] || s.conversation_id.slice(0, 8);
  }
  return s.conversation_id.slice(0, 8);
}

export function shortWs(ws: string | null): string {
  if (!ws) return "—";
  const parts = ws.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.slice(-2).join("/") || ws;
}
