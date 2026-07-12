import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ConversationTimelinePageSchema,
  ConversationsPageSchema,
  LiveEventEnvelopeSchema,
  LiveOverviewSchema,
  ModelInputResponseSchema,
  RolloutDetailSchema,
  RolloutsPageSchema
} from "@gestalt/live-contracts";
import type { CanonicalEvent, Conversation } from "../events/schemas";
import { resolveGestaltHome } from "../home/resolveGestaltHome";
import {
  traceBlobPath,
  type RolloutDetail,
  type RolloutReader,
  type RolloutRecord,
  type RolloutSummary
} from "../rollout";
import type { Runtime } from "../runtime/createRuntime";
import type { SessionHistoryReader } from "../session/history";
import type { SessionEventRecord } from "../session/schemas";
import { createInMemorySessionStore } from "../session/store";
import { createLiveEventBus } from "./eventBus";
import { createLiveRunStore } from "./runStore";
import { startLiveDebugServer } from "./server";

const NOW = new Date("2026-07-12T12:00:00.000Z");
const STATE_HASH = "a".repeat(64);
const ROLLOUT_ID = "rollout-live-api";
const BINARY_SHA256 = "b".repeat(64);

async function main(): Promise<void> {
  verifyLiveEventBudgets();
  verifyLiveRunStoreBoundaries();
  const directory = await mkdtemp(path.join(tmpdir(), "gestalt-live-api-"));
  const home = await resolveGestaltHome({ homePath: directory });
  const bus = createLiveEventBus({ now: () => NOW });
  const runStore = createLiveRunStore(bus);
  let server: Awaited<ReturnType<typeof startLiveDebugServer>> | undefined;
  try {
    await writeFile(
      home.configPath,
      "trace_binary_capture_enabled = true\nsession_recent_history_hours = 24\n",
      "utf8"
    );
    const sessionStore = createInMemorySessionStore({ now: () => NOW });
    const records = [
      await sessionStore.appendEvent(messageEvent("alpha", "first")),
      await sessionStore.appendEvent(messageEvent("beta", "second"))
    ];
    const historyOnlyStore = createInMemorySessionStore({ now: () => NOW });
    const historyOnly = await historyOnlyStore.appendEvent(
      messageEvent("history-only", "evicted history result")
    );
    const history = historyReader([...records, historyOnly]);
    const rolloutReader = fixtureRolloutReader();
    const runtime = {
      home,
      sessionStore,
      sessionHistory: history,
      rolloutReader,
      ingestEvent: async () => records[0]!,
      dispatchEvent: async () => ({ outcome: Promise.resolve(undefined) }),
      handleEvent: async () => undefined,
      handleMessageWindow: async () => undefined,
      exportDiagnostics: (options?: { exportedAt?: string }) =>
        sessionStore.exportDiagnostics(options),
      whenIdle: async () => undefined
    } satisfies Runtime;

    const png = Buffer.concat([
      Buffer.from("89504e470d0a1a0a", "hex"),
      Buffer.from("live-api-fixture", "utf8")
    ]);
    const sha256 = createHash("sha256").update(png).digest("hex");
    const blobPath = traceBlobPath(home.tracesDir, sha256);
    await mkdir(path.dirname(blobPath), { recursive: true });
    await writeFile(blobPath, png);

    server = await startLiveDebugServer({
      runtime,
      bus,
      runStore,
      rolloutReader,
      host: "127.0.0.1",
      port: 0,
      now: () => NOW
    });

    bus.publish("agent.run.started", {
      traceId: "active-rollout",
      eventId: records[1]!.event.id,
      startedAt: NOW.toISOString(),
      window: {
        id: "active-window",
        conversation: records[1]!.event.conversation,
        reason: "mention",
        eventIds: [records[1]!.event.id],
        closedAt: NOW.toISOString()
      },
      eventRecords: [records[1]]
    });

    const overview = LiveOverviewSchema.parse(await getJson(server.url, "/api/live/overview"));
    assert.equal(overview.counts.conversations, 2);
    assert.equal(overview.counts.activeRollouts, 1);
    assert.equal(overview.binaryCaptureEnabled, true);

    const conversations = ConversationsPageSchema.parse(
      await getJson(server.url, "/api/live/conversations?limit=1&query=first")
    );
    assert.equal(conversations.items.length, 1);
    assert.equal(conversations.items[0]?.id, "alpha");
    const evictedConversation = ConversationsPageSchema.parse(
      await getJson(
        server.url,
        "/api/live/conversations?limit=1&query=evicted%20history"
      )
    );
    assert.equal(evictedConversation.items[0]?.id, "history-only");

    const timeline = ConversationTimelinePageSchema.parse(
      await getJson(
        server.url,
        `/api/live/conversations/${encodeURIComponent("group:alpha")}/timeline?limit=1`
      )
    );
    assert.equal(timeline.items[0]?.type, "message");
    assert.equal(timeline.items[0]?.id, `message:${records[0]!.id}`);

    const rollouts = RolloutsPageSchema.parse(
      await getJson(server.url, "/api/live/rollouts?limit=50")
    );
    assert.ok(rollouts.items.some((item) => item.id === ROLLOUT_ID));
    assert.ok(
      rollouts.items.some(
        (item) => item.id === "active-rollout" && item.status === "running"
      )
    );
    bus.publish("agent.run.completed", {
      traceId: "active-rollout",
      endedAt: NOW.toISOString(),
      proposedActions: [],
      toolResults: []
    });
    assert.equal(runStore.getActiveRun("active-rollout")?.status, "running");
    bus.publish("rollout.recorded", {
      rolloutId: "active-rollout",
      conversationKey: "group:beta",
      status: "completed"
    });
    assert.equal(runStore.getActiveRun("active-rollout"), undefined);

    const detail = RolloutDetailSchema.parse(
      await getJson(server.url, `/api/live/rollouts/${ROLLOUT_ID}`)
    );
    assert.equal(detail.generations[0]?.id, "generation-1");
    assert.deepEqual(detail.generations[0]?.cache, {
      readInputTokens: 8,
      writeInputTokens: 1,
      prefixReused: true
    });
    assert.equal(detail.records.length, 4);

    for (const view of ["delta", "full"] as const) {
      const modelInput = ModelInputResponseSchema.parse(
        await getJson(
          server.url,
          `/api/live/rollouts/${ROLLOUT_ID}/model-input?generationId=generation-1&view=${view}`
        )
      );
      assert.equal(modelInput.messages[0]?.id, "system-1");
      assert.equal(modelInput.stateHash, STATE_HASH);
      assert.equal(JSON.stringify(modelInput).includes(BINARY_SHA256), true);
      assert.equal(JSON.stringify(modelInput).includes("binary-secret"), false);
    }

    const blobResponse = await fetch(`${server.url}/api/live/blobs/${sha256}`);
    assert.equal(blobResponse.status, 200);
    assert.equal(blobResponse.headers.get("content-type"), "image/png");
    assert.equal(blobResponse.headers.get("x-content-type-options"), "nosniff");
    assert.equal(blobResponse.headers.get("cache-control"), "no-store");
    assert.match(blobResponse.headers.get("content-security-policy") ?? "", /sandbox/);
    assert.deepEqual(Buffer.from(await blobResponse.arrayBuffer()), png);

    assert.equal(
      (await fetch(`${server.url}/api/live/snapshot`)).status,
      404
    );
    assert.equal(
      (await fetch(`${server.url}/api/live/traces/${ROLLOUT_ID}`)).status,
      404
    );
    assert.equal(
      (await fetch(`${server.url}/api/live/rollouts?limit=201`)).status,
      400
    );

    bus.publish("agent.phase.changed", {
      traceId: ROLLOUT_ID,
      phase: "model_running",
      secretPayload: "must-not-reach-sse"
    });
    const controller = new AbortController();
    const eventsResponse = await fetch(`${server.url}/api/live/events`, {
      headers: { "Last-Event-ID": "0" },
      signal: controller.signal
    });
    const sseText = await readSseUntil(eventsResponse, "agent.phase.changed");
    controller.abort();
    assert.equal(sseText.includes("must-not-reach-sse"), false);
    const eventPayload = sseText
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)) as unknown)
      .map((value) => LiveEventEnvelopeSchema.parse(value))
      .find((event) => event.type === "agent.phase.changed");
    assert.deepEqual(eventPayload?.data.entity, {
      kind: "rollout",
      id: ROLLOUT_ID
    });

    await verifySlowSseClientIsDisconnected(server.url, bus);
  } finally {
    await server?.close();
    runStore.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}

function verifyLiveRunStoreBoundaries(): void {
  let current = new Date(NOW);
  const bus = createLiveEventBus({ now: () => current });
  const store = createLiveRunStore(bus);
  try {
    for (let index = 0; index < 501; index += 1) {
      current = new Date(NOW.valueOf() + index);
      bus.publish("agent.run.started", {
        traceId: `bounded-rollout-${index}`,
        eventId: `bounded-event-${index}`,
        startedAt: current.toISOString(),
        window: {
          id: `bounded-window-${index}`,
          conversation: { kind: "group", id: "bounded" },
          reason: "mention",
          eventIds: [`bounded-event-${index}`],
          closedAt: current.toISOString()
        },
        eventRecords: []
      });
    }
    assert.equal(store.getActiveRuns(() => current).length, 500);
    assert.equal(
      store.getActiveRuns(
        () => new Date(current.valueOf() + 24 * 60 * 60 * 1_000 + 1)
      ).length,
      0
    );
  } finally {
    store.dispose();
  }
}

function verifyLiveEventBudgets(): void {
  const bus = createLiveEventBus({
    now: () => NOW,
    maxBufferedEvents: 3,
    maxBufferedBytes: 900,
    maxEventBytes: 300
  });
  for (let index = 0; index < 10; index += 1) {
    const event = bus.publish("agent.run.failed", {
      traceId: `rollout-${index}`,
      summary: "x".repeat(10_000)
    });
    assert.ok(Buffer.byteLength(JSON.stringify(event), "utf8") <= 300);
    assert.equal(JSON.stringify(event).includes("x".repeat(100)), false);
  }
  const recent = bus.getRecentEvents();
  assert.ok(recent.length <= 3);
  assert.ok(
    recent.reduce(
      (total, event) => total + Buffer.byteLength(JSON.stringify(event), "utf8"),
      0
    ) <= 900
  );
}

function fixtureRolloutReader(): RolloutReader {
  const summary: RolloutSummary = {
    id: ROLLOUT_ID,
    activeLoopId: "loop-live-api",
    startedAt: NOW.toISOString(),
    endedAt: new Date(NOW.valueOf() + 250).toISOString(),
    status: "completed",
    conversationKey: "group:alpha",
    recordCount: 4,
    messageCount: 1,
    generationCount: 1,
    toolCount: 0,
    outboundActionCount: 0,
    unresolvedOutboundActionCount: 0,
    spanCount: 0,
    byteLength: 512
  };
  const records: RolloutRecord[] = [
    {
      id: "record-start",
      rolloutId: ROLLOUT_ID,
      timestamp: NOW.toISOString(),
      type: "rollout_started",
      activeLoopId: "loop-live-api",
      conversationKey: "group:alpha"
    },
    {
      id: "record-init",
      rolloutId: ROLLOUT_ID,
      timestamp: NOW.toISOString(),
      type: "model_session_initialized",
      messages: [
        {
          id: "system-1",
          role: "system",
          content: {
            media: {
              source: "connector-action",
              url: "https://example.invalid/image?token=binary-secret",
              value: {
                type: "binary",
                mediaType: "image/png",
                byteLength: 123_652,
                sha256: BINARY_SHA256,
                availability: "not_captured"
              }
            }
          }
        }
      ],
      tools: [{ name: "say" }],
      stateHash: STATE_HASH,
      model: "fixture-model"
    },
    {
      id: "record-generation",
      rolloutId: ROLLOUT_ID,
      timestamp: new Date(NOW.valueOf() + 200).toISOString(),
      type: "generation_completed",
      generationId: "generation-1",
      inputStateHash: STATE_HASH,
      inputMessageCount: 1,
      outputMessageIds: [],
      status: "completed",
      model: "fixture-model",
      finishReason: "stop",
      latencyMs: 200,
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
      cacheUsage: { readTokens: 8, writeTokens: 1 }
    },
    {
      id: "record-finish",
      rolloutId: ROLLOUT_ID,
      timestamp: new Date(NOW.valueOf() + 250).toISOString(),
      type: "rollout_finished",
      status: "completed",
      summary: {
        recordCount: 3,
        messageCount: 1,
        generationCount: 1,
        toolCount: 0,
        outboundActionCount: 0,
        unresolvedOutboundActionCount: 0,
        spanCount: 0
      }
    }
  ];
  const detail: RolloutDetail = {
    summary,
    records,
    unresolvedOutboundActions: [],
    truncatedTail: false
  };
  return {
    async list(query = {}) {
      const matchesQuery =
        !query.query ||
        [summary.id, summary.conversationKey].some((value) =>
          value?.includes(query.query ?? "")
        );
      const matchesStatus = !query.status || query.status === summary.status;
      return {
        items: query.cursor || !matchesQuery || !matchesStatus ? [] : [summary]
      };
    },
    async read(id) {
      if (id !== ROLLOUT_ID) throw new Error(`Rollout ${id} was not found.`);
      return detail;
    },
    async reconstructInput(id, generationId) {
      if (id !== ROLLOUT_ID || generationId !== "generation-1") {
        throw new Error("Generation was not found.");
      }
      return {
        rolloutId: id,
        generationId,
        stateHash: STATE_HASH,
        messageCount: 1,
        messages: [
          {
            id: "system-1",
            role: "system",
            content: {
              media: {
                source: "connector-action",
                url: "https://example.invalid/image?token=binary-secret",
                value: {
                  type: "binary",
                  mediaType: "image/png",
                  byteLength: 123_652,
                  sha256: BINARY_SHA256,
                  availability: "not_captured"
                }
              }
            }
          }
        ],
        tools: [{ name: "say" }]
      };
    }
  };
}

function historyReader(records: SessionEventRecord[]): SessionHistoryReader {
  return {
    async *iterateRecentMessages() {
      yield* records;
    },
    async recentMessages(conversation) {
      return records.filter((record) => sameConversation(record, conversation));
    },
    async findRecentMessage(conversation, messageId) {
      return records.find(
        (record) =>
          sameConversation(record, conversation) &&
          record.event.message.id === messageId
      );
    },
    async searchMessages(_query, scope, _range, cursor, limit = 50) {
      const matches = records
        .filter(
          (record) =>
            !scope.conversation || sameConversation(record, scope.conversation)
        )
        .reverse();
      const start = cursor ? Number(cursor) : 0;
      const items = matches.slice(start, start + limit);
      return {
        items,
        ...(start + items.length < matches.length
          ? { nextCursor: String(start + items.length) }
          : {})
      };
    }
  };
}

function sameConversation(
  record: SessionEventRecord,
  conversation: Conversation
): boolean {
  return (
    record.event.conversation.kind === conversation.kind &&
    record.event.conversation.id === conversation.id
  );
}

function messageEvent(conversationId: string, text: string): CanonicalEvent {
  return {
    id: `event-${conversationId}`,
    type: "MessageReceived",
    occurredAt: NOW.toISOString(),
    source: { platform: "verify" },
    conversation: { kind: "group", id: conversationId },
    sender: { id: "user", displayName: "Verifier" },
    message: {
      id: `message-${conversationId}`,
      text,
      mentionsBot: false
    }
  };
}

async function getJson(baseUrl: string, pathname: string): Promise<unknown> {
  const response = await fetch(`${baseUrl}${pathname}`);
  assert.equal(response.status, 200, `${pathname} returned ${response.status}`);
  return response.json();
}

async function readSseUntil(response: Response, expected: string): Promise<string> {
  assert.equal(response.status, 200);
  assert.ok(response.body);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes(expected)) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value, { stream: true });
  }
  await reader.cancel();
  return text;
}

async function verifySlowSseClientIsDisconnected(
  baseUrl: string,
  bus: ReturnType<typeof createLiveEventBus>
): Promise<void> {
  const controller = new AbortController();
  const response = await fetch(`${baseUrl}/api/live/events`, {
    signal: controller.signal
  });
  assert.equal(response.status, 200);
  assert.ok(response.body);
  const reader = response.body.getReader();
  // Consume the ready frame, then deliberately stop reading while the server
  // receives a synchronous burst. ServerResponse must not retain the burst.
  assert.equal((await reader.read()).done, false);
  for (let index = 0; index < 5_000; index += 1) {
    bus.publish("agent.phase.changed", {
      traceId: `slow-client-${index}`,
      phase: "model_running"
    });
  }

  try {
    const completed = await Promise.race([
      readUntilDone(reader).then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 2_000))
    ]);
    assert.equal(
      completed,
      true,
      "A backpressured SSE client should be disconnected."
    );
  } finally {
    controller.abort();
    await reader.cancel().catch(() => undefined);
  }
}

async function readUntilDone(
  reader: ReadableStreamDefaultReader<Uint8Array>
): Promise<void> {
  while (!(await reader.read()).done) {
    // Drain only after the publisher burst has finished.
  }
}

await main();
