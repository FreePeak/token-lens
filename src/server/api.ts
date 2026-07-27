import { join } from "path";
import type { Database } from "bun:sqlite";
import { getDrivers, getOverview, getSessionDetail, listSessions } from "../db/queries";

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
      if (url.pathname === "/api/overview") {
        return json(getOverview(db, sinceMs(url)));
      }
      if (url.pathname === "/api/sessions") {
        return json(listSessions(db, { sinceMs: sinceMs(url), limit: 500 }));
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
        return json(getDrivers(db, dim, sinceMs(url)));
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
        if (await index.exists()) return cors(new Response(index));
      }

      return json({ error: "not found" }, 404);
    },
  });

  return {
    port: server.port ?? port,
    stop: () => server.stop(),
  };
}
