import assert from "node:assert/strict";
import { once } from "node:events";
import { WebSocketServer, type WebSocket } from "ws";
import { isConnectorOutcomeUnknownError } from "../types";
import {
  createOneBotForwardWsTransport,
  type OneBotEventFailureCode
} from "./transport";

const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
await once(server, "listening");
const address = server.address();
if (!address || typeof address === "string") {
  throw new Error("Expected a TCP address for the OneBot transport verifier.");
}

let acceptClient!: (socket: WebSocket) => void;
const connectedClient = new Promise<WebSocket>((resolve) => {
  acceptClient = resolve;
});
server.on("connection", acceptClient);

const transport = createOneBotForwardWsTransport({
  url: `ws://127.0.0.1:${address.port}`,
  ingressConcurrency: 2,
  ingressQueueCapacity: 2
});
const failureCodes: OneBotEventFailureCode[] = [];
const failureWaiters = new Map<OneBotEventFailureCode, () => void>();
transport.onEventError((failure) => {
  failureCodes.push(failure.code);
  failureWaiters.get(failure.code)?.();
});

let releaseBurst!: () => void;
const burstGate = new Promise<void>((resolve) => {
  releaseBurst = resolve;
});
const handled: number[] = [];
let activeHandlers = 0;
let maxActiveHandlers = 0;
transport.onEvent(async (rawEvent) => {
  const event = rawEvent as { id?: unknown };
  if (event.id === "bad") {
    throw new Error("expected transport handler failure");
  }
  if (typeof event.id !== "number") {
    return;
  }
  activeHandlers += 1;
  maxActiveHandlers = Math.max(maxActiveHandlers, activeHandlers);
  try {
    if (event.id < 2) {
      await burstGate;
    }
    handled.push(event.id);
  } finally {
    activeHandlers -= 1;
  }
});

try {
  await transport.connect();
  const client = await connectedClient;
  const overflowObserved = waitForFailure("queue_overflow");
  for (let id = 0; id < 5; id += 1) {
    client.send(JSON.stringify({ id }));
  }
  await overflowObserved;
  assert.deepEqual(transport.getIngressStats(), {
    active: 2,
    queued: 2,
    accepted: 4,
    completed: 0,
    failed: 0,
    rejected: 1
  });
  releaseBurst();
  await transport.whenIngressIdle();
  assert.deepEqual(handled, [0, 1, 2, 3]);
  assert.equal(maxActiveHandlers, 2);

  const handlerFailureObserved = waitForFailure("handler_failed");
  client.send(JSON.stringify({ id: "bad" }));
  await handlerFailureObserved;
  await transport.whenIngressIdle();

  const invalidMessageObserved = waitForFailure("invalid_message");
  client.send("{");
  await invalidMessageObserved;

  const receivedAction = once(client, "message");
  const action = transport.callAction("send_group_msg", {
    group_id: 1,
    message: "hello"
  });
  await receivedAction;
  client.close();
  await assert.rejects(action, isConnectorOutcomeUnknownError);

  assert.deepEqual(failureCodes, [
    "queue_overflow",
    "handler_failed",
    "invalid_message"
  ]);
} finally {
  await transport[Symbol.asyncDispose]();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

console.log(
  JSON.stringify({
    ok: true,
    maxActiveHandlers,
    failureCodes,
    unknownOutcomeOnDisconnect: true
  })
);

function waitForFailure(code: OneBotEventFailureCode): Promise<void> {
  return new Promise<void>((resolve) => {
    failureWaiters.set(code, () => {
      failureWaiters.delete(code);
      resolve();
    });
  });
}
