import { createReadStream, existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sanitizeUntrustedValue } from "../privacy/stickerRedaction";
import type { Runtime } from "../runtime/createRuntime";
import {
  normalizeStickerCatalogQuery,
  type StickerCatalogQuery
} from "../stickers/service";
import type { LiveEventBus } from "./eventBus";
import { loadLiveTraceDetail, loadLiveWorkspace } from "./snapshot";
import type { LiveRunStore } from "./runStore";
import type { RuntimeLiveEventEnvelope, TraceWorkspace } from "./viewTypes";

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
  workspaceCache: LiveWorkspaceCache;
  sseResponses: Set<ServerResponse>;
}

interface LiveWorkspaceCache {
  get(): Promise<TraceWorkspace>;
  invalidate(): void;
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
  const workspaceCache = createLiveWorkspaceCache(async () =>
    loadLiveWorkspace({
      home: options.runtime.home,
      sessionSnapshot: options.runtime.exportSession({
        exportedAt: now().toISOString()
      }),
      activeRuns: options.runStore.getActiveRuns(now),
      now
    })
  );
  const stopInvalidatingWorkspace = options.bus.subscribe({
    onEvent() {
      workspaceCache.invalidate();
    }
  });
  const sseResponses = new Set<ServerResponse>();

  const server = http.createServer((request, response) => {
    void handleRequest(request, response, {
      ...options,
      host,
      port,
      now,
      workspaceCache,
      sseResponses,
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
      stopInvalidatingWorkspace();
      for (const response of sseResponses) {
        response.end();
      }
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
  if (!isAllowedRequest(request)) {
    sendJson(response, 403, { error: "Live debug server rejected the request origin" });
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
    const snapshot = await options.workspaceCache.get();
    sendJson(response, 200, snapshot);
    return;
  }

  if (pathname === "/api/live/stickers/snapshot") {
    const catalogQuery = parseStickerCatalogQuery(url);
    if (!options.runtime.stickers) {
      sendJson(
        response,
        200,
        emptyStickerSnapshot(options.now().toISOString(), catalogQuery)
      );
      return;
    }
    sendJson(
      response,
      200,
      await options.runtime.stickers.snapshot(catalogQuery)
    );
    return;
  }

  const stickerAssetMatch = pathname.match(
    /^\/api\/live\/stickers\/assets\/([^/]+)\/(original|contact-sheet)$/
  );
  if (stickerAssetMatch?.[1] && stickerAssetMatch[2]) {
    if (!options.runtime.stickers) {
      sendJson(response, 404, { error: "Sticker subsystem is not configured" });
      return;
    }
    const filePath = await options.runtime.stickers.resolveAssetPath(
      decodeURIComponent(stickerAssetMatch[1]),
      stickerAssetMatch[2] === "contact-sheet" ? "contact-sheet" : "original"
    );
    if (!filePath || !(await fileIfExists(filePath))) {
      sendJson(response, 404, { error: "Sticker asset not found" });
      return;
    }
    if (!isSupportedStickerAsset(filePath)) {
      sendJson(response, 415, { error: "Unsupported sticker asset type" });
      return;
    }
    await serveFile(response, filePath, { untrustedImage: true });
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
    serveSse(request, response, options.bus, options.now, options.sseResponses);
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

function createLiveWorkspaceCache(
  load: () => Promise<TraceWorkspace>
): LiveWorkspaceCache {
  let cached: TraceWorkspace | undefined;
  let inFlight: Promise<TraceWorkspace> | undefined;
  let version = 0;

  return {
    get() {
      if (cached) {
        return Promise.resolve(cached);
      }
      if (inFlight) {
        return inFlight;
      }
      const loadVersion = version;
      inFlight = load()
        .then((workspace) => {
          if (version === loadVersion) {
            cached = workspace;
          }
          return workspace;
        })
        .finally(() => {
          inFlight = undefined;
        });
      return inFlight;
    },
    invalidate() {
      version += 1;
      cached = undefined;
    }
  };
}

function serveSse(
  request: IncomingMessage,
  response: ServerResponse,
  bus: LiveEventBus,
  now: () => Date,
  responses: Set<ServerResponse>
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

  responses.add(response);
  const cleanup = (): void => {
    clearInterval(heartbeat);
    unsubscribe();
    responses.delete(response);
  };
  request.once("close", cleanup);
  response.once("close", cleanup);
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

  await serveFile(response, candidate);
}

async function serveFile(
  response: ServerResponse,
  candidate: string,
  options: { untrustedImage?: boolean } = {}
): Promise<void> {
  response.writeHead(200, {
    "Content-Type": contentType(candidate),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...(options.untrustedImage
      ? {
          "Content-Security-Policy": "default-src 'none'; sandbox",
          "Cross-Origin-Resource-Policy": "same-origin"
        }
      : {})
  });
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(candidate);
    stream.on("error", reject);
    stream.on("end", resolve);
    stream.pipe(response);
  });
}

function isSupportedStickerAsset(filePath: string): boolean {
  return [".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(
    path.extname(filePath).toLowerCase()
  );
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
  response.end(JSON.stringify(sanitizeUntrustedValue(value)));
}

function writeSse(
  response: ServerResponse,
  event: RuntimeLiveEventEnvelope
): void {
  if (event.id > 0) {
    response.write(`id: ${event.id}\n`);
  }
  response.write("event: live\n");
  response.write(`data: ${JSON.stringify(sanitizeUntrustedValue(event))}\n\n`);
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
    case ".gif":
      return "image/gif";
    case ".avif":
      return "image/avif";
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}

function emptyStickerSnapshot(
  generatedAt: string,
  catalogInput: StickerCatalogQuery = {}
): Record<string, unknown> {
  const catalog = normalizeStickerCatalogQuery(catalogInput);
  return {
    available: false,
    unavailableReason:
      "Sticker subsystem is not configured. Configure an embedding model to enable it.",
    generatedAt,
    scraping: {
      configuredEnabled: false,
      effectiveEnabled: false
    },
    processing: {
      queued: 0,
      running: 0,
      failed: 0,
      ready: 0,
      duplicates: 0
    },
    embedding: {
      rowCount: 0,
      indexState: "empty"
    },
    jobs: [],
    catalog: {
      offset: catalog.offset,
      limit: catalog.limit,
      total: 0
    },
    stickers: []
  };
}

function parseStickerCatalogQuery(url: URL): StickerCatalogQuery {
  const status = url.searchParams.get("status");
  const source = url.searchParams.get("source");
  const offset = parseFiniteNumber(url.searchParams.get("offset"));
  const limit = parseFiniteNumber(url.searchParams.get("limit"));
  return {
    ...(offset !== undefined ? { offset } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(url.searchParams.has("query")
      ? { query: url.searchParams.get("query") ?? "" }
      : {}),
    ...(status === "ready" || status === "processing" || status === "failed"
      ? { status }
      : {}),
    ...(source === "mface" || source === "image-sticker" ? { source } : {})
  };
}

function parseFiniteNumber(value: string | null): number | undefined {
  if (value === null || value.trim() === "") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isAllowedRequest(request: IncomingMessage): boolean {
  const hostHeader = Array.isArray(request.headers.host)
    ? request.headers.host[0]
    : request.headers.host;
  if (!hostHeader) {
    return false;
  }
  const origin = request.headers.origin;
  if (!origin) {
    return true;
  }
  try {
    const parsed = new URL(origin);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.host.toLowerCase() === hostHeader.toLowerCase()
    );
  } catch {
    return false;
  }
}

export function resolveDefaultTraceUiDir(fromUrl: string): string {
  const moduleDir = path.dirname(fileURLToPath(fromUrl));
  const candidates = [
    path.join(moduleDir, "live-ui"),
    path.resolve(moduleDir, "../dist/live-ui"),
    path.resolve(moduleDir, "../../trace/dist")
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}
