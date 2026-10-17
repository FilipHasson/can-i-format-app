import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import type { Db } from "../core/db.ts";
import type { AppConfig } from "../core/config.ts";
import { saveConfig } from "../core/config.ts";
import { JobManager, type JobEvent } from "./jobs.ts";
import { handleApi, type AppContext } from "./routes.ts";

const WEB_ROOT = path.join(import.meta.dirname, "..", "web");

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
};

/**
 * This server can list and read any directory the user can, so it binds to
 * loopback only and refuses requests whose Host header is not local. Without
 * that check a page on the wider internet could point a browser at
 * `http://127.0.0.1:4111` and use it to walk the filesystem.
 */
const HOST = "127.0.0.1";

function isLocalHost(header: string | undefined): boolean {
  if (!header) return false;
  const host = header.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

async function serveStatic(url: URL, res: ServerResponse): Promise<boolean> {
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const resolved = path.join(WEB_ROOT, path.normalize(requested));

  // path.normalize collapses `..`, but the containment check is what actually
  // guarantees we never serve outside the web directory.
  if (!resolved.startsWith(WEB_ROOT)) {
    res.writeHead(403).end("Forbidden");
    return true;
  }

  try {
    const body = await fs.readFile(resolved);
    res.writeHead(200, {
      "content-type": CONTENT_TYPES[path.extname(resolved).toLowerCase()] ?? "application/octet-stream",
      "content-length": body.length,
      "cache-control": "no-cache",
    });
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

/** Server-sent events, so long jobs can stream progress to the page. */
function serveEvents(jobs: JobManager, req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write(": connected\n\n");

  const send = (event: JobEvent) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  jobs.on("job", send);

  // Without traffic, proxies and browsers eventually drop an idle stream.
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 20000);

  const cleanup = () => {
    clearInterval(heartbeat);
    jobs.off("job", send);
  };
  req.on("close", cleanup);
  res.on("close", cleanup);
}

export interface StartedServer {
  url: string;
  port: number;
  close: () => Promise<void>;
}

export async function startServer(db: Db, config: AppConfig): Promise<StartedServer> {
  const jobs = new JobManager();
  const ctx: AppContext = {
    db,
    jobs,
    config,
    saveConfig: async (next) => {
      ctx.config = next;
      await saveConfig(next);
    },
  };

  const server = http.createServer((req, res) => {
    void (async () => {
      if (!isLocalHost(req.headers.host)) {
        res.writeHead(403, { "content-type": "text/plain" }).end("Local requests only.");
        return;
      }

      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

      if (url.pathname === "/api/events") {
        serveEvents(jobs, req, res);
        return;
      }

      try {
        if (await handleApi(ctx, req, res, url)) return;
        if (await serveStatic(url, res)) return;
        res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
        }
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
    })();
  });

  const port = await listen(server, config.port);

  return {
    url: `http://${HOST}:${port}`,
    port,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

/** Uses the configured port, falling back to any free one if it is taken. */
function listen(server: http.Server, preferred: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE" && preferred !== 0) {
        server.removeListener("error", onError);
        server.listen(0, HOST, () => resolve((server.address() as { port: number }).port));
        return;
      }
      reject(err);
    };

    server.once("error", onError);
    server.listen(preferred, HOST, () => {
      server.removeListener("error", onError);
      resolve((server.address() as { port: number }).port);
    });
  });
}
