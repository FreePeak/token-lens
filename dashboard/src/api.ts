import type { SessionRollup, OverviewStats, DriverRow, SessionDetail } from "../../src/shared/types";

export type { SessionRollup, OverviewStats, DriverRow, SessionDetail };

export type SessionSort = "date" | "cost" | "duration";

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${res.status} ${path}`);
  return res.json() as Promise<T>;
}

export const api = {
  profiles: () => get<string[]>("/api/profiles"),
  overview: (days?: number, profile?: string) =>
    get<OverviewStats>(`/api/overview?${params({ days, profile })}`),
  sessions: (days?: number, profile?: string, sort?: SessionSort) =>
    get<SessionRollup[]>(`/api/sessions?${params({ days, profile, sort })}`),
  session: (id: string) => get<SessionDetail>(`/api/sessions/${encodeURIComponent(id)}`),
  drivers: (by: "tool" | "model" | "workspace", days?: number, profile?: string) =>
    get<DriverRow[]>(`/api/drivers?by=${by}&${params({ days, profile })}`),
};

function params(opts: { days?: number; profile?: string; sort?: SessionSort }): string {
  const p: string[] = [];
  if (opts.days != null) p.push(`days=${opts.days}`);
  if (opts.profile) p.push(`profile=${encodeURIComponent(opts.profile)}`);
  if (opts.sort && opts.sort !== "date") p.push(`sort=${opts.sort}`);
  return p.join("&");
}

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

export function fmtDate(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function shortTitle(s: SessionRollup): string {
  if (s.title?.trim()) return s.title.trim().slice(0, 80);
  if (s.workspace) {
    const parts = s.workspace.replace(/\\/g, "/").split("/");
    return parts[parts.length - 1] || s.conversation_id.slice(0, 8);
  }
  return s.conversation_id.slice(0, 8);
}
