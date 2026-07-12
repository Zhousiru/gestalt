import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  createLiveEventBus,
  createLiveRunStore,
  createMockConnector,
  createMockModel,
  createNoopDreamingRunner,
  createRuntime,
  startLiveDebugServer
} from "@gestalt/app";
import {
  ConversationTimelinePageSchema,
  ConversationsPageSchema,
  LiveOverviewSchema,
  ModelInputResponseSchema,
  RolloutDetailSchema,
  RolloutsPageSchema
} from "@gestalt/live-contracts";
import { writeArtifactJson } from "./artifactBinary";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const holdOpen = process.argv.includes("--hold");
const artifactDir = path.join(
  repoRoot,
  "harness",
  "artifacts",
  "traces-ui"
);
const tempHome = await mkdtemp(path.join(os.tmpdir(), "gestalt-traces-ui-"));
await cp(
  path.join(repoRoot, "harness", "fixtures", "homes", "simple-group-test"),
  tempHome,
  { recursive: true }
);
const fixedNow = new Date("2026-07-12T11:20:00.000Z");
const now = () => new Date(fixedNow);
const bus = createLiveEventBus({ now });
const runStore = createLiveRunStore(bus);
const connector = createMockConnector({ now });
const runtime = await createRuntime({
  gestaltHome: tempHome,
  connector,
  model: createMockModel({ now }),
  dreamingRunner: createNoopDreamingRunner(),
  liveEvents: bus,
  now
});
const port = await findAvailablePort();
const server = await startLiveDebugServer({
  runtime,
  bus,
  runStore,
  host: "127.0.0.1",
  port,
  uiDir: path.join(repoRoot, "packages", "trace", "dist"),
  now
});

try {
  const event = connector.createMessageEvent({
    conversationId: "trace-ui-group",
    conversationName: "Trace UI Contract Group",
    senderId: "alice",
    senderName: "Alice",
    messageId: "trace-ui-message-1",
    text: "gestalt 验证 rollout-first API",
    mentionsBot: true
  });
  event.id = "trace-ui-event-1";
  const result = await runtime.handleEvent(event);
  assert.ok(result, "fixture should complete one agent turn");
  await runtime.whenIdle();

  const overview = LiveOverviewSchema.parse(
    await fetchJson(`${server.url}/api/live/overview`)
  );
  assert.equal(overview.binaryCaptureEnabled, false);
  assert.ok(overview.counts.conversations >= 1);
  assert.ok(overview.counts.rollouts >= 1);

  const conversations = ConversationsPageSchema.parse(
    await fetchJson(
      `${server.url}/api/live/conversations?limit=1&query=${encodeURIComponent("Contract Group")}`
    )
  );
  assert.equal(conversations.items.length, 1);
  const conversation = conversations.items[0];
  assert.ok(conversation);
  assert.equal(conversation.key, "group:trace-ui-group");

  const timeline = ConversationTimelinePageSchema.parse(
    await fetchJson(
      `${server.url}/api/live/conversations/${encodeURIComponent(conversation.key)}/timeline?limit=1`
    )
  );
  assert.equal(timeline.conversation.key, conversation.key);
  assert.equal(timeline.items.length, 1);

  const rolloutPage = RolloutsPageSchema.parse(
    await fetchJson(`${server.url}/api/live/rollouts?limit=1&status=completed`)
  );
  assert.equal(rolloutPage.items.length, 1);
  const rolloutSummary = rolloutPage.items[0];
  assert.ok(rolloutSummary);

  const rollout = RolloutDetailSchema.parse(
    await fetchJson(
      `${server.url}/api/live/rollouts/${encodeURIComponent(rolloutSummary.id)}`
    )
  );
  assert.equal(rollout.summary.id, rolloutSummary.id);
  assert.ok(rollout.modelSession.initialMessageCount >= 1);
  assert.ok(rollout.generations.length >= 1);
  assert.ok(
    rollout.records.some((record) => record.type === "rollout_finished")
  );
  const generation = rollout.generations[0];
  assert.ok(generation);

  const deltaInput = ModelInputResponseSchema.parse(
    await fetchJson(
      `${server.url}/api/live/rollouts/${encodeURIComponent(rolloutSummary.id)}/model-input?generationId=${encodeURIComponent(generation.id)}&view=delta`
    )
  );
  const fullInput = ModelInputResponseSchema.parse(
    await fetchJson(
      `${server.url}/api/live/rollouts/${encodeURIComponent(rolloutSummary.id)}/model-input?generationId=${encodeURIComponent(generation.id)}&view=full`
    )
  );
  assert.equal(deltaInput.stateHash, generation.inputStateHash);
  assert.equal(fullInput.stateHash, generation.inputStateHash);
  assert.equal(fullInput.messages.length, fullInput.messageCount);
  assert.ok(fullInput.tools && fullInput.tools.length > 0);

  const binaryResponse = await fetch(
    `${server.url}/api/live/blobs/${"a".repeat(64)}`
  );
  assert.equal(binaryResponse.status, 404);
  assert.match(await binaryResponse.text(), /Binary capture is disabled/);

  const invalidPage = await fetch(
    `${server.url}/api/live/rollouts?limit=201`
  );
  assert.equal(invalidPage.status, 400);

  const uiResponse = await fetch(server.url);
  assert.equal(uiResponse.status, 200);
  assert.match(
    uiResponse.headers.get("content-type") ?? "",
    /^text\/html(?:;|$)/
  );

  const artifact = {
    ok: true,
    overview,
    conversation,
    timelineItems: timeline.items.length,
    rollout: rollout.summary,
    recordTypes: rollout.records.map((record) => record.type),
    generationId: generation.id,
    deltaMessageCount: deltaInput.messages.length,
    fullMessageCount: fullInput.messages.length,
    binaryDisabledStatus: binaryResponse.status,
    invalidPageStatus: invalidPage.status
  };
  await mkdir(artifactDir, { recursive: true });
  await writeArtifactJson(path.join(artifactDir, "result.json"), artifact);
  console.log(JSON.stringify({ ...artifact, artifactDir }, null, 2));
  if (holdOpen) {
    console.log(`Trace UI preview: ${server.url}`);
    await waitForShutdownSignal();
  }
} finally {
  await server.close();
  runStore.dispose();
  await rm(tempHome, { recursive: true, force: true });
}

async function waitForShutdownSignal(): Promise<void> {
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  const body = await response.json();
  assert.equal(
    response.status,
    200,
    `${url} returned ${response.status}: ${JSON.stringify(body)}`
  );
  return body;
}

async function findAvailablePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}
