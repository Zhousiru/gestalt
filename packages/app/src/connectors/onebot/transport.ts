import { randomUUID } from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";
import type { ConnectorCallResult } from "../types";
import { OneBotActionResponseSchema } from "./schemas";

export interface OneBotTransport extends AsyncDisposable {
  readonly mode: "forward_ws" | "reverse_ws";
  connect(): Promise<void>;
  callAction(
    action: string,
    params?: Record<string, unknown>
  ): Promise<ConnectorCallResult & { data?: unknown }>;
  onEvent(handler: (event: unknown) => void | Promise<void>): void;
}

export interface CreateOneBotForwardWsTransportOptions {
  url: string;
  accessToken?: string;
  connectTimeoutMs?: number;
}

export interface CreateOneBotReverseWsTransportOptions {
  host?: string;
  port: number;
  path?: string;
  accessToken?: string;
}

type EventHandler = (event: unknown) => void | Promise<void>;

export function createOneBotForwardWsTransport(
  options: CreateOneBotForwardWsTransportOptions
): OneBotTransport {
  let socket: WebSocket | undefined;
  const pending = new Map<
    string,
    {
      resolve: (value: ConnectorCallResult & { data?: unknown }) => void;
      reject: (error: Error) => void;
    }
  >();
  const eventHandlers: EventHandler[] = [];

  return {
    mode: "forward_ws",

    async connect() {
      if (socket && socket.readyState === WebSocket.OPEN) {
        return;
      }
      socket = await openClientWebSocket(options);
      socket.on("message", (data) => {
        handleIncoming(data, pending, eventHandlers);
      });
      socket.on("close", () => {
        rejectPending(pending, new Error("OneBot WebSocket closed."));
      });
      socket.on("error", (error) => {
        rejectPending(
          pending,
          error instanceof Error ? error : new Error(String(error))
        );
      });
    },

    async callAction(action, params) {
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        throw new Error("OneBot WebSocket is not connected.");
      }
      return callActionOverSocket(socket, pending, action, params);
    },

    onEvent(handler) {
      eventHandlers.push(handler);
    },

    async [Symbol.asyncDispose]() {
      rejectPending(pending, new Error("OneBot transport disposed."));
      socket?.close();
    }
  };
}

export function createOneBotReverseWsTransport(
  options: CreateOneBotReverseWsTransportOptions
): OneBotTransport {
  let server: WebSocketServer | undefined;
  let socket: WebSocket | undefined;
  const pending = new Map<
    string,
    {
      resolve: (value: ConnectorCallResult & { data?: unknown }) => void;
      reject: (error: Error) => void;
    }
  >();
  const eventHandlers: EventHandler[] = [];

  return {
    mode: "reverse_ws",

    async connect() {
      if (server) {
        return;
      }

      server = new WebSocketServer({
        host: options.host ?? "0.0.0.0",
        port: options.port,
        path: options.path ?? "/onebot/v11/ws",
        verifyClient(info, done) {
          if (!options.accessToken) {
            done(true);
            return;
          }
          done(readAccessToken(info.req.url, info.req.headers.authorization) === options.accessToken);
        }
      });

      server.on("connection", (connectedSocket) => {
        socket = connectedSocket;
        socket.on("message", (data) => {
          handleIncoming(data, pending, eventHandlers);
        });
        socket.on("close", () => {
          socket = undefined;
          rejectPending(pending, new Error("OneBot reverse WebSocket closed."));
        });
      });

      await new Promise<void>((resolve) => {
        server?.once("listening", resolve);
      });
    },

    async callAction(action, params) {
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        throw new Error("OneBot reverse WebSocket has no active client.");
      }
      return callActionOverSocket(socket, pending, action, params);
    },

    onEvent(handler) {
      eventHandlers.push(handler);
    },

    async [Symbol.asyncDispose]() {
      rejectPending(pending, new Error("OneBot transport disposed."));
      socket?.close();
      await new Promise<void>((resolve) => {
        server?.close(() => resolve());
      });
      server = undefined;
    }
  };
}

async function openClientWebSocket(
  options: CreateOneBotForwardWsTransportOptions
): Promise<WebSocket> {
  const headers =
    options.accessToken !== undefined
      ? { Authorization: `Bearer ${options.accessToken}` }
      : undefined;
  const socket = new WebSocket(options.url, headers ? { headers } : {});

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("Timed out connecting to OneBot WebSocket."));
    }, options.connectTimeoutMs ?? 5_000);

    socket.once("open", () => {
      clearTimeout(timeout);
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

function callActionOverSocket(
  socket: WebSocket,
  pending: Map<
    string,
    {
      resolve: (value: ConnectorCallResult & { data?: unknown }) => void;
      reject: (error: Error) => void;
    }
  >,
  action: string,
  params?: Record<string, unknown>
): Promise<ConnectorCallResult & { data?: unknown }> {
  const echo = randomUUID();
  const payload: Record<string, unknown> = {
    action,
    echo
  };
  if (params) {
    payload.params = params;
  }

  const promise = new Promise<ConnectorCallResult & { data?: unknown }>(
    (resolve, reject) => {
      pending.set(echo, { resolve, reject });
    }
  );
  socket.send(JSON.stringify(payload));
  return promise;
}

function handleIncoming(
  data: WebSocket.RawData,
  pending: Map<
    string,
    {
      resolve: (value: ConnectorCallResult & { data?: unknown }) => void;
      reject: (error: Error) => void;
    }
  >,
  eventHandlers: EventHandler[]
): void {
  const parsed = parseJsonMessage(data);
  const echo = readEcho(parsed);
  if (echo && pending.has(echo)) {
    const pendingCall = pending.get(echo);
    pending.delete(echo);
    const response = OneBotActionResponseSchema.parse(parsed);
    const error = response.message ?? response.wording;
    const result: ConnectorCallResult & { data?: unknown } = {
      ok: response.status === "ok" || response.status === "async",
      ...(response.data !== undefined ? { data: response.data } : {}),
      ...(error ? { error } : {})
    };
    pendingCall?.resolve(result);
    return;
  }

  for (const handler of eventHandlers) {
    void handler(parsed);
  }
}

function parseJsonMessage(data: WebSocket.RawData): unknown {
  const text = Array.isArray(data)
    ? Buffer.concat(data).toString("utf8")
    : Buffer.isBuffer(data)
      ? data.toString("utf8")
      : data.toString();
  return JSON.parse(text);
}

function readEcho(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const echo = (value as { echo?: unknown }).echo;
  return typeof echo === "string" ? echo : undefined;
}

function rejectPending(
  pending: Map<
    string,
    {
      resolve: (value: ConnectorCallResult & { data?: unknown }) => void;
      reject: (error: Error) => void;
    }
  >,
  error: Error
): void {
  for (const call of pending.values()) {
    call.reject(error);
  }
  pending.clear();
}

function readAccessToken(
  requestUrl: string | undefined,
  authorization: string | undefined
): string | undefined {
  if (authorization?.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length);
  }
  if (!requestUrl) {
    return undefined;
  }
  const url = new URL(requestUrl, "ws://localhost");
  return url.searchParams.get("access_token") ?? undefined;
}
