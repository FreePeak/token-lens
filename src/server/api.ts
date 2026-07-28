import { join } from "path";
import type { Database } from "bun:sqlite";
import {
  getDrivers,
  getOverview,
  getSessionDetail,
  listProfiles,
  listSessions,
  type SessionSort,
} from "../db/queries";

function cors(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  return new Response(res.body, { status: res.status, headers });
}

function json(data: unknown, status = 200): Response {
  return cors(
    new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

function sinceMs(url: URL): number | undefined {
  const days = url.searchParams.get("days");
  if (!days) return undefined;
  const n = Number(days);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Date.now() - n * 24 * 60 * 60 * 1000;
}

function profile(url: URL): string | undefined {
  const p = url.searchParams.get("profile");
  return p && p !== "all" ? p : undefined;
}

function sort(url: URL): SessionSort {
  const s = url.searchParams.get("sort");
  if (s === "cost" || s === "duration" || s === "date") return s;
  return "date";
}

export function startServer(
  db: Database,
  opts: { port?: number; staticDir?: string } = {},
): { port: number; stop: () => void } {
  const port = opts.port ?? 3847;
  const staticDir = opts.staticDir;

  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "OPTIONS") {
        return cors(new Response(null, { status: 204 }));
      }

      if (url.pathname === "/api/health") {
        return json({ ok: true });
      }
      if (url.pathname === "/api/profiles") {
        return json(listProfiles(db));
      }
      if (url.pathname === "/api/overview") {
        return json(getOverview(db, sinceMs(url), profile(url)));
      }
      if (url.pathname === "/api/sessions") {
        return json(
          listSessions(db, {
            sinceMs: sinceMs(url),
            limit: 2000,
            profile: profile(url),
            sort: sort(url),
          }),
        );
      }
      if (url.pathname.startsWith("/api/sessions/")) {
        const id = decodeURIComponent(url.pathname.slice("/api/sessions/".length));
        const detail = getSessionDetail(db, id);
        if (!detail) return json({ error: "not found" }, 404);
        return json(detail);
      }
      if (url.pathname === "/api/drivers") {
        const dim = (url.searchParams.get("by") ?? "tool") as "tool" | "model" | "workspace";
        if (!["tool", "model", "workspace"].includes(dim)) {
          return json({ error: "by must be tool|model|workspace" }, 400);
        }
        return json(getDrivers(db, dim, sinceMs(url), profile(url)));
      }

      // Static dashboard
      if (staticDir) {
        let path = url.pathname === "/" ? "/index.html" : url.pathname;
        const file = Bun.file(join(staticDir, path));
        if (await file.exists()) {
          return cors(new Response(file));
        }
        // SPA fallback
        const index = Bun.file(join(staticDir, "index.html"));
        const resp = new Response(await index.text(), {
          headers: { "Content-Type": "text/html", "Cache-Control": "no-cache" },
        });
        return cors(resp);
      }

      return json({ error: "not found" }, 404);
    },
  });

  return {
    port: server.port ?? port,
    stop: () => server.stop(),
  };
}
