import { createReadStream, existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Runtime } from "../runtime/createRuntime";
import type { LiveEventBus } from "./eventBus";
import { loadLiveTraceDetail, loadLiveWorkspace } from "./snapshot";
import type { LiveRunStore } from "./runStore";
import type { RuntimeLiveEventEnvelope } from "./viewTypes";

export interface StartLiveDebugServerOptions {
  runtime: Runtime;
  bus: LiveEventBus;
  runStore: LiveRunStore;
  host?: string;
  port?: number;
  uiDir?: string;
  now?: () => Date;
}

export interface LiveDebugServer {
  url: string;
  close(): Promise<void>;
}

interface ResolvedLiveDebugServerOptions {
  runtime: Runtime;
  bus: LiveEventBus;
  runStore: LiveRunStore;
  host: string;
  port: number;
  uiDir?: string;
  now: () => Date;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3000;

export async function startLiveDebugServer(
  options: StartLiveDebugServerOptions
): Promise<LiveDebugServer> {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const now = options.now ?? (() => new Date());
  const uiDir = options.uiDir ? path.resolve(options.uiDir) : undefined;

  const server = http.createServer((request, response) => {
    void handleRequest(request, response, {
      ...options,
      host,
      port,
      now,
      ...(uiDir ? { uiDir } : {})
    }).catch((error) => {
      if (!response.headersSent) {
        sendJson(response, 500, {
          error: error instanceof Error ? error.message : String(error)
        });
      } else {
        response.destroy(error instanceof Error ? error : undefined);
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });

  return {
    url: `http://${host}:${port}`,
    close() {
      return new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: ResolvedLiveDebugServerOptions
): Promise<void> {
  if (request.method !== "GET") {
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }

  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  const pathname = url.pathname;

  if (pathname === "/api/live/health") {
    sendJson(response, 200, {
      ok: true,
      at: options.now().toISOString(),
      home: options.runtime.home
    });
    return;
  }

  if (pathname === "/api/live/snapshot") {
    const snapshot = await loadLiveWorkspace({
      home: options.runtime.home,
      sessionSnapshot: options.runtime.exportSession({
        exportedAt: options.now().toISOString()
      }),
      activeRuns: options.runStore.getActiveRuns(options.now),
      now: options.now
    });
    sendJson(response, 200, snapshot);
    return;
  }

  const traceMatch = pathname.match(/^\/api\/live\/traces\/([^/]+)$/);
  if (traceMatch?.[1]) {
    const detail = await loadLiveTraceDetail({
      home: options.runtime.home,
      sessionSnapshot: options.runtime.exportSession({
        exportedAt: options.now().toISOString()
      }),
      activeRuns: options.runStore.getActiveRuns(options.now),
      traceId: decodeURIComponent(traceMatch[1]),
      now: options.now
    });
    if (!detail) {
      sendJson(response, 404, { error: "Trace not found" });
      return;
    }
    sendJson(response, 200, detail);
    return;
  }

  if (pathname === "/api/live/events") {
    serveSse(request, response, options.bus, options.now);
    return;
  }

  if (options.uiDir) {
    await serveStatic(response, options.uiDir, pathname);
    return;
  }

  sendJson(response, 404, {
    error: "Not found",
    hint: "Live UI assets are missing from the application distribution."
  });
}

function serveSse(
  request: IncomingMessage,
  response: ServerResponse,
  bus: LiveEventBus,
  now: () => Date
): void {
  response.writeHead(200, {
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Content-Type": "text/event-stream; charset=utf-8",
    "X-Accel-Buffering": "no"
  });
  response.write(": connected\n\n");
  writeSse(response, {
    id: 0,
    type: "live.ready",
    at: now().toISOString(),
    data: {
      ok: true
    }
  });

  const lastEventId = parseLastEventId(request.headers["last-event-id"]);
  const unsubscribe = bus.subscribe({
    ...(lastEventId !== undefined ? { lastEventId } : {}),
    onEvent(event) {
      writeSse(response, event);
    }
  });
  const heartbeat = setInterval(() => {
    writeSse(response, {
      id: 0,
      type: "live.heartbeat",
      at: now().toISOString(),
      data: {
        ok: true
      }
    });
  }, 15_000);

  request.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

async function serveStatic(
  response: ServerResponse,
  uiDir: string,
  pathname: string
): Promise<void> {
  const target = resolveStaticPath(uiDir, pathname);
  if (!target) {
    sendJson(response, 403, { error: "Forbidden" });
    return;
  }

  const candidate = await pickExistingAsset(target, uiDir);
  if (!candidate) {
    sendJson(response, 404, { error: "Not found" });
    return;
  }

  response.writeHead(200, {
    "Content-Type": contentType(candidate)
  });
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(candidate);
    stream.on("error", reject);
    stream.on("end", resolve);
    stream.pipe(response);
  });
}

function resolveStaticPath(uiDir: string, pathname: string): string | undefined {
  let decoded = "/";
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }

  const relativePath = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const resolved = path.resolve(uiDir, relativePath);
  return isWithinDirectory(uiDir, resolved) ? resolved : undefined;
}

async function pickExistingAsset(
  target: string,
  uiDir: string
): Promise<string | undefined> {
  const direct = await fileIfExists(target);
  if (direct) {
    return direct;
  }
  return fileIfExists(path.join(uiDir, "index.html"));
}

async function fileIfExists(target: string): Promise<string | undefined> {
  try {
    const stats = await stat(target);
    return stats.isFile() ? target : undefined;
  } catch {
    return undefined;
  }
}

function isWithinDirectory(directory: string, target: string): boolean {
  const relative = path.relative(directory, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(value));
}

function writeSse(
  response: ServerResponse,
  event: RuntimeLiveEventEnvelope
): void {
  if (event.id > 0) {
    response.write(`id: ${event.id}\n`);
  }
  response.write("event: live\n");
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function parseLastEventId(value: string | string[] | undefined): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) {
    return undefined;
  }
  const numeric = Number(raw);
  return Number.isInteger(numeric) && numeric >= 0 ? numeric : undefined;
}

function contentType(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".map":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}

export function resolveDefaultTraceUiDir(fromUrl: string): string {
  const moduleDir = path.dirname(fileURLToPath(fromUrl));
  const candidates = [
    path.join(moduleDir, "live-ui"),
    path.resolve(moduleDir, "../dist/live-ui")
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}
