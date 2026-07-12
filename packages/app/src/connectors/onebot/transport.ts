import { randomUUID } from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";
import {
  ConnectorOutcomeUnknownError,
  type ConnectorCallResult
} from "../types";
import { OneBotActionResponseSchema } from "./schemas";
import {
  createOneBotIngressQueue,
  type OneBotIngressFailure,
  type OneBotIngressQueue,
  type OneBotIngressQueueStats
} from "./ingressQueue";

export type OneBotEventFailureCode =
  | OneBotIngressFailure<unknown>["code"]
  | "invalid_message";

export interface OneBotEventFailure {
  code: OneBotEventFailureCode;
  error: Error;
  event?: unknown;
}

export interface OneBotTransport extends AsyncDisposable {
  readonly mode: "forward_ws" | "reverse_ws";
  connect(): Promise<void>;
  callAction(
    action: string,
    params?: Record<string, unknown>
  ): Promise<ConnectorCallResult & { data?: unknown }>;
  onEvent(handler: (event: unknown) => void | Promise<void>): void;
  onEventError(
    handler: (failure: OneBotEventFailure) => void | Promise<void>
  ): void;
  getIngressStats(): OneBotIngressQueueStats;
  whenIngressIdle(): Promise<void>;
}

export interface OneBotIngressOptions {
  ingressConcurrency?: number;
  ingressQueueCapacity?: number;
}

export interface CreateOneBotForwardWsTransportOptions
  extends OneBotIngressOptions {
  url: string;
  accessToken?: string;
  connectTimeoutMs?: number;
}

export interface CreateOneBotReverseWsTransportOptions
  extends OneBotIngressOptions {
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
  const eventErrorHandlers: Array<
    (failure: OneBotEventFailure) => void | Promise<void>
  > = [];
  const ingress = createTransportIngress(
    eventHandlers,
    eventErrorHandlers,
    options
  );

  return {
    mode: "forward_ws",

    async connect() {
      if (socket && socket.readyState === WebSocket.OPEN) {
        return;
      }
      socket = await openClientWebSocket(options);
      socket.on("message", (data) => {
        handleIncoming(data, pending, ingress, eventErrorHandlers);
      });
      socket.on("close", () => {
        rejectPending(
          pending,
          unknownOutcome(
            "OneBot WebSocket closed before action results arrived."
          )
        );
      });
      socket.on("error", (error) => {
        rejectPending(
          pending,
          unknownOutcome(
            "OneBot WebSocket failed before action results arrived.",
            error
          )
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

    onEventError(handler) {
      eventErrorHandlers.push(handler);
    },

    getIngressStats() {
      return ingress.getStats();
    },

    whenIngressIdle() {
      return ingress.whenIdle();
    },

    async [Symbol.asyncDispose]() {
      rejectPending(
        pending,
        unknownOutcome(
          "OneBot transport was disposed before action results arrived."
        )
      );
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
  const eventErrorHandlers: Array<
    (failure: OneBotEventFailure) => void | Promise<void>
  > = [];
  const ingress = createTransportIngress(
    eventHandlers,
    eventErrorHandlers,
    options
  );

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
          done(
            readAccessToken(info.req.url, info.req.headers.authorization) ===
              options.accessToken
          );
        }
      });

      server.on("connection", (connectedSocket) => {
        if (socket && socket !== connectedSocket) {
          rejectPending(
            pending,
            unknownOutcome(
              "OneBot reverse WebSocket was replaced before action results arrived."
            )
          );
          socket.close();
        }
        socket = connectedSocket;
        socket.on("message", (data) => {
          handleIncoming(data, pending, ingress, eventErrorHandlers);
        });
        socket.on("close", () => {
          if (socket !== connectedSocket) {
            return;
          }
          socket = undefined;
          rejectPending(
            pending,
            unknownOutcome(
              "OneBot reverse WebSocket closed before action results arrived."
            )
          );
        });
        socket.on("error", (error) => {
          if (socket !== connectedSocket) {
            return;
          }
          rejectPending(
            pending,
            unknownOutcome(
              "OneBot reverse WebSocket failed before action results arrived.",
              error
            )
          );
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

    onEventError(handler) {
      eventErrorHandlers.push(handler);
    },

    getIngressStats() {
      return ingress.getStats();
    },

    whenIngressIdle() {
      return ingress.whenIdle();
    },

    async [Symbol.asyncDispose]() {
      rejectPending(
        pending,
        unknownOutcome(
          "OneBot transport was disposed before action results arrived."
        )
      );
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
  try {
    socket.send(JSON.stringify(payload), (error) => {
      if (!error) {
        return;
      }
      const pendingCall = pending.get(echo);
      if (!pendingCall) {
        return;
      }
      pending.delete(echo);
      pendingCall.reject(
        unknownOutcome("OneBot action dispatch failed after it was queued.", error)
      );
    });
  } catch (error) {
    const pendingCall = pending.get(echo);
    pending.delete(echo);
    pendingCall?.reject(toError(error));
  }
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
  ingress: OneBotIngressQueue<unknown>,
  eventErrorHandlers: Array<
    (failure: OneBotEventFailure) => void | Promise<void>
  >
): void {
  let parsed: unknown;
  try {
    parsed = parseJsonMessage(data);
  } catch (error) {
    reportEventFailure(eventErrorHandlers, {
      code: "invalid_message",
      error: toError(error)
    });
    return;
  }
  const echo = readEcho(parsed);
  if (echo && pending.has(echo)) {
    const pendingCall = pending.get(echo);
    pending.delete(echo);
    const parsedResponse = OneBotActionResponseSchema.safeParse(parsed);
    if (!parsedResponse.success) {
      pendingCall?.reject(
        unknownOutcome(
          "OneBot returned a malformed action response; remote outcome is unknown.",
          parsedResponse.error
        )
      );
      return;
    }
    const response = parsedResponse.data;
    const error = response.message ?? response.wording;
    const result: ConnectorCallResult & { data?: unknown } = {
      ok: response.status === "ok" || response.status === "async",
      ...(response.data !== undefined ? { data: response.data } : {}),
      ...(error ? { error } : {})
    };
    pendingCall?.resolve(result);
    return;
  }

  ingress.enqueue(parsed);
}

function createTransportIngress(
  eventHandlers: EventHandler[],
  eventErrorHandlers: Array<
    (failure: OneBotEventFailure) => void | Promise<void>
  >,
  options: OneBotIngressOptions
): OneBotIngressQueue<unknown> {
  return createOneBotIngressQueue({
    ...(options.ingressConcurrency !== undefined
      ? { concurrency: options.ingressConcurrency }
      : {}),
    ...(options.ingressQueueCapacity !== undefined
      ? { capacity: options.ingressQueueCapacity }
      : {}),
    async handle(event) {
      for (const handler of eventHandlers) {
        await handler(event);
      }
    },
    onFailure(failure) {
      reportEventFailure(eventErrorHandlers, failure);
    }
  });
}

function reportEventFailure(
  handlers: Array<(failure: OneBotEventFailure) => void | Promise<void>>,
  failure: OneBotEventFailure
): void {
  if (handlers.length === 0) {
    console.error(`[onebot:${failure.code}] ${failure.error.message}`);
    return;
  }
  for (const handler of handlers) {
    try {
      void Promise.resolve(handler(failure)).catch(() => undefined);
    } catch {
      // An error reporter must never create another unhandled rejection.
    }
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

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function unknownOutcome(
  message: string,
  cause?: unknown
): ConnectorOutcomeUnknownError {
  return new ConnectorOutcomeUnknownError(
    message,
    cause === undefined ? {} : { cause }
  );
}
