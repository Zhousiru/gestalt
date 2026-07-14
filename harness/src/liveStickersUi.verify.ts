import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  createLiveEventBus,
  createLiveRunStore,
  createMockConnector,
  createMockModel,
  createRuntime,
  createStickerLogger,
  createStickerService,
  createStickerStore,
  createStickerVectorIndex,
  extractStickerObservations,
  resolveGestaltHome,
  startLiveDebugServer,
  type MessageReceivedEvent,
  type StickerAnalyzer,
  type StickerEmbedder,
  type StickerManagementResponse
} from "@gestalt/app";
import sharp from "sharp";
import { writeArtifactJson } from "./artifactBinary";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const uiDir = path.join(repoRoot, "packages", "app", "dist", "live-ui");
const artifactDir = path.join(
  repoRoot,
  "harness",
  "artifacts",
  "live-stickers-ui"
);
const tempHome = await mkdtemp(path.join(os.tmpdir(), "gestalt-live-stickers-"));
const now = () => new Date("2026-07-11T12:00:00.000Z");
const portArgument = process.argv.find((argument) => argument.startsWith("--port="));
const port = portArgument
  ? Number(portArgument.slice("--port=".length))
  : await findAvailablePort();
const hold = process.argv.includes("--hold");

try {
  await writeFile(
    path.join(tempHome, "config.toml"),
    "dreaming_enabled = false\n",
    "utf8"
  );
  const home = await resolveGestaltHome({ homePath: tempHome });
  const bus = createLiveEventBus({ now });
  const runStore = createLiveRunStore(bus);
  const store = createStickerStore(home);
  const connector = createMockConnector({ now });
  let analyzerCallCount = 0;
  const embedder: StickerEmbedder = {
    provider: "fixture-embedding",
    model: "fixture-embedding-v1",
    id: "live-stickers-v1",
    configuredDimensions: 3,
    async embed(text) {
      return {
        vector: text.includes("庆祝") ? [0, 1, 0] : [1, 0, 0]
      };
    }
  };
  const analyzer: StickerAnalyzer = {
    async describe(input) {
      analyzerCallCount += 1;
      return {
        desc: input.animated
          ? `An excited blue character dances in a loop to celebrate. blue character, dancing, excited, celebration, revision-${analyzerCallCount}`
          : `A friendly red cat waves hello. red cat, waving, greeting, friendly, revision-${analyzerCallCount}`,
        provider: "fixture-sub",
        model: "fixture-vision-v1",
        promptHash: "live-stickers-prompt-v1"
      };
    }
  };
  const vectorIndex = await createStickerVectorIndex({
    directory: home.stickerLanceDbDir,
    embeddingId: embedder.id
  });
  const service = createStickerService({
    home,
    connector,
    store,
    logger: createStickerLogger(home),
    mediaResolver: {
      async resolve(job) {
        const value = String(job.segment.data.url ?? job.segment.data.file ?? "");
        return Buffer.from(value.slice("base64://".length), "base64");
      }
    },
    analyzer,
    embedder,
    vectorIndex,
    configuredEnabled: true,
    liveEvents: bus,
    now
  });

  const staticImage = await createStaticImage();
  const animatedImage = await createAnimatedImage();
  await service.observe(
    stickerEvent("live-static", "image", staticImage, "image")
  );
  await service.observe(
    stickerEvent("live-animated", "mface", animatedImage, "mface")
  );
  await service.whenIdle();

  const queued = await store.createJob(
    onlyObservation(
      stickerEvent("live-queued", "image", staticImage, "image")
    ),
    "2026-07-11T12:01:00.000Z"
  );
  await store.updateJob(queued.id, {
    status: "queued",
    attempts: 1,
    failedStage: "describing",
    error: "Fixture retry after transient vision timeout",
    updatedAt: "2026-07-11T12:01:30.000Z"
  });
  const failed = await store.createJob(
    onlyObservation(
      stickerEvent("live-failed", "image", staticImage, "image")
    ),
    "2026-07-11T12:02:00.000Z"
  );
  await store.updateJob(failed.id, {
    status: "failed",
    attempts: 3,
    failedStage: "describing",
    error: "Fixture vision model timeout",
    updatedAt: "2026-07-11T12:02:30.000Z"
  });

  const runtime = await createRuntime({
    gestaltHome: tempHome,
    connector,
    model: createMockModel({ now }),
    stickerService: service,
    liveEvents: bus,
    now
  });
  const snapshotSecretKey = "snapshot-secret-key-sentinel";
  const snapshotSecretUrl =
    "https://example.invalid/snapshot.gif?token=snapshot-secret";
  await runtime.ingestEvent({
    id: "live-snapshot-privacy-event",
    type: "MessageReceived",
    occurredAt: "2026-07-11T12:03:00.000Z",
    source: { platform: "qq", connector: "onebot-v11" },
    conversation: { kind: "group", id: "live-privacy-group" },
    sender: { id: "privacy-user" },
    message: {
      id: "live-snapshot-privacy-message",
      text: `[CQ:mface,emoji_id=snapshot-emoji-secret,key=${snapshotSecretKey},url=${snapshotSecretUrl},file=marketface]`,
      rawText: `[CQ:mface,key=${snapshotSecretKey},url=${snapshotSecretUrl}]`,
      mentionsBot: false,
      sourceContent: {
        format: "onebot-v11",
        segments: [
          {
            type: "mface",
            data: {
              emoji_id: "snapshot-emoji-secret",
              emoji_package_id: "snapshot-package-secret",
              key: snapshotSecretKey,
              url: snapshotSecretUrl,
              path: "C:\\private\\snapshot-secret.gif"
            }
          }
        ]
      }
    },
    raw: { snapshotSecretKey, snapshotSecretUrl }
  });
  const allInterfacesServer = await startLiveDebugServer({
    runtime,
    bus,
    runStore,
    host: "0.0.0.0",
    port: 0,
    uiDir,
    now
  });
  await allInterfacesServer.close();
  const server = await startLiveDebugServer({
    runtime,
    bus,
    runStore,
    host: "127.0.0.1",
    port,
    uiDir,
    now
  });

  try {
    const crossOriginResponse = await fetch(`${server.url}/api/live/health`, {
      headers: { origin: "https://attacker.example" }
    });
    assert.equal(crossOriginResponse.status, 403);
    const crossOriginMutationResponse = await fetch(
      `${server.url}/api/live/stickers/manage`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://attacker.example"
        },
        body: JSON.stringify({
          action: "delete",
          stickerIds: ["stk_cross_origin_probe"]
        })
      }
    );
    assert.equal(crossOriginMutationResponse.status, 403);
    const legacySnapshotResponse = await fetch(
      `${server.url}/api/live/snapshot`
    );
    assert.equal(legacySnapshotResponse.status, 404);
    const legacySnapshotText = await legacySnapshotResponse.text();
    assert.equal(legacySnapshotText.includes(snapshotSecretKey), false);
    assert.equal(legacySnapshotText.includes(snapshotSecretUrl), false);
    const snapshotResponse = await fetch(
      `${server.url}/api/live/stickers/snapshot`
    );
    assert.equal(snapshotResponse.status, 200);
    const snapshotText = await snapshotResponse.text();
    assert.doesNotMatch(snapshotText, /private-fixture-key/);
    assert.doesNotMatch(snapshotText, /emoji-mface|live-fixture/);
    assert.doesNotMatch(snapshotText, /base64:\/\//);
    assert.doesNotMatch(snapshotText, /\[CQ:(?:mface|image)/);
    const snapshot = JSON.parse(snapshotText) as {
      available: boolean;
      processing: { queued: number; failed: number; ready: number };
      embedding: { rowCount: number };
      catalog: { offset: number; limit: number; total: number };
      jobs: Array<{
        id: string;
        stage: string;
        lastFailedStage?: string;
      }>;
      stickers: Array<{
        id: string;
        desc: string;
        thumbnailUrl: string;
        contactSheetUrl?: string;
      }>;
    };
    assert.equal(snapshot.available, true);
    assert.equal(snapshot.processing.queued, 1);
    assert.equal(snapshot.processing.failed, 1);
    assert.equal(snapshot.processing.ready, 2);
    assert.deepEqual(snapshot.catalog, { offset: 0, limit: 48, total: 2 });
    assert.equal(snapshot.stickers.length, 2);
    assert.ok(snapshot.stickers.every((sticker) => !("sources" in sticker)));
    assert.equal(
      snapshot.jobs.find((job) => job.id === queued.id)?.stage,
      "queued"
    );
    assert.equal(
      snapshot.jobs.find((job) => job.id === queued.id)?.lastFailedStage,
      "describing"
    );

    const firstPageResponse = await fetch(
      `${server.url}/api/live/stickers/snapshot?offset=0&limit=1`
    );
    assert.equal(firstPageResponse.status, 200);
    const firstPage = (await firstPageResponse.json()) as {
      catalog: { offset: number; limit: number; total: number };
      stickers: unknown[];
    };
    assert.deepEqual(firstPage.catalog, { offset: 0, limit: 1, total: 2 });
    assert.equal(firstPage.stickers.length, 1);

    const clampedPage = (await fetch(
      `${server.url}/api/live/stickers/snapshot?limit=500&source=mface&status=ready&query=${encodeURIComponent("celebration")}`
    ).then((response) => response.json())) as {
      catalog: { limit: number; total: number };
      stickers: unknown[];
    };
    assert.equal(clampedPage.catalog.limit, 100);
    assert.equal(clampedPage.catalog.total, 1);
    assert.equal(clampedPage.stickers.length, 1);

    const animated = snapshot.stickers.find((sticker) => sticker.contactSheetUrl);
    assert.ok(animated?.contactSheetUrl);
    const assetResponse = await fetch(`${server.url}${animated.contactSheetUrl}`);
    assert.equal(assetResponse.status, 200);
    assert.equal(assetResponse.headers.get("content-type"), "image/png");
    assert.equal(assetResponse.headers.get("x-content-type-options"), "nosniff");
    assert.match(
      assetResponse.headers.get("content-security-policy") ?? "",
      /sandbox/
    );
    assert.ok((await assetResponse.arrayBuffer()).byteLength > 0);

    const managementMethodResponse = await fetch(
      `${server.url}/api/live/stickers/manage`
    );
    assert.equal(managementMethodResponse.status, 405);
    const invalidManagementResponse = await fetch(
      `${server.url}/api/live/stickers/manage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "delete", stickerIds: [] })
      }
    );
    assert.equal(invalidManagementResponse.status, 400);

    const stickerIds = snapshot.stickers.map((sticker) => sticker.id);
    const descriptionsBeforeRebuild = new Map(
      snapshot.stickers.map((sticker) => [sticker.id, sticker.desc])
    );
    const rebuildResponse = await fetch(
      `${server.url}/api/live/stickers/manage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "rebuild", stickerIds })
      }
    );
    assert.equal(rebuildResponse.status, 200);
    const rebuildResult =
      (await rebuildResponse.json()) as StickerManagementResponse;
    assert.equal(rebuildResult.action, "rebuild");
    assert.equal(rebuildResult.requested, 2);
    assert.equal(rebuildResult.succeeded, 2);
    assert.equal(rebuildResult.failed, 0);
    assert.ok(rebuildResult.results.every((result) => result.outcome === "rebuilt"));
    assert.equal(analyzerCallCount, 4);
    const rebuiltSnapshot = (await fetch(
      `${server.url}/api/live/stickers/snapshot`
    ).then((response) => response.json())) as typeof snapshot;
    assert.equal(rebuiltSnapshot.embedding.rowCount, 2);
    assert.ok(
      rebuiltSnapshot.stickers.every(
        (sticker) =>
          sticker.desc !== descriptionsBeforeRebuild.get(sticker.id) &&
          sticker.desc.includes("revision-")
      )
    );

    const sseController = new AbortController();
    const sseResponse = await fetch(`${server.url}/api/live/events`, {
      signal: sseController.signal
    });
    assert.equal(sseResponse.status, 200);
    const reader = sseResponse.body?.getReader();
    assert.ok(reader);
    const secretKey = "sse-secret-key-sentinel";
    const secretEmojiId = "sse-secret-emoji-sentinel";
    const secretPackageId = "sse-secret-package-sentinel";
    const secretPath = "C:\\private\\sticker-sentinel.gif";
    const secretUrl = "https://example.invalid/sticker.gif?token=sse-secret";
    bus.publish(
      "sticker.job.updated",
      {
        job: {
          id: "safe-live-job",
          status: "queued",
          segment: {
            type: "mface",
            data: {
              key: secretKey,
              emoji_id: secretEmojiId,
              emoji_package_id: secretPackageId,
              url: secretUrl,
              path: secretPath,
              file: "base64://c2VjcmV0"
            }
          }
        }
      },
      now().toISOString()
    );
    bus.publish(
      "session.event.appended",
      {
        id: "safe-session-event",
        event: {
          message: {
            text: `[CQ:mface,emoji_id=${secretEmojiId},emoji_package_id=${secretPackageId},key=${secretKey},url=${secretUrl},file=base64://c2VjcmV0]`,
            rawText: `[CQ:mface,key=${secretKey},path=${secretPath}]`,
            sourceContent: {
              format: "onebot-v11",
              segments: [
                {
                  type: "mface",
                  data: {
                    key: secretKey,
                    emoji_id: secretEmojiId,
                    emoji_package_id: secretPackageId,
                    url: secretUrl,
                    path: secretPath,
                    file: "base64://c2VjcmV0"
                  }
                }
              ]
            }
          },
          raw: { secretKey }
        }
      },
      now().toISOString()
    );
    bus.publish(
      "sticker.catalog.updated",
      { stickerId: "sse-catalog-sentinel" },
      now().toISOString()
    );
    const sseText = await readUntil(reader, "sticker.catalog.updated");
    assert.match(sseText, /sticker\.catalog\.updated/);
    for (const privateField of [
      secretKey,
      secretEmojiId,
      secretPackageId,
      secretPath,
      secretUrl,
      "base64://",
      "[CQ:mface"
    ]) {
      const serializedField =
        privateField === secretPath
          ? JSON.stringify(privateField).slice(1, -1)
          : privateField;
      assert.equal(sseText.includes(serializedField), false);
    }
    await reader.cancel();
    sseController.abort();

    const deleteTarget = rebuiltSnapshot.stickers.find(
      (sticker) => sticker.id === animated.id
    );
    assert.ok(deleteTarget);
    assert.ok(deleteTarget.contactSheetUrl);
    const deleteResponse = await fetch(
      `${server.url}/api/live/stickers/manage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "delete",
          stickerIds: [deleteTarget.id]
        })
      }
    );
    assert.equal(deleteResponse.status, 200);
    const deleteResult =
      (await deleteResponse.json()) as StickerManagementResponse;
    assert.deepEqual(
      {
        action: deleteResult.action,
        requested: deleteResult.requested,
        succeeded: deleteResult.succeeded,
        failed: deleteResult.failed,
        outcome: deleteResult.results[0]?.outcome
      },
      {
        action: "delete",
        requested: 1,
        succeeded: 1,
        failed: 0,
        outcome: "deleted"
      }
    );
    const snapshotAfterDelete = (await fetch(
      `${server.url}/api/live/stickers/snapshot`
    ).then((response) => response.json())) as typeof snapshot;
    assert.equal(snapshotAfterDelete.catalog.total, 1);
    assert.equal(snapshotAfterDelete.processing.ready, 1);
    assert.equal(snapshotAfterDelete.embedding.rowCount, 1);
    assert.equal(await store.readRecord(deleteTarget.id), undefined);
    assert.equal((await vectorIndex.listStickerIds()).includes(deleteTarget.id), false);
    assert.equal(
      (await fetch(`${server.url}${deleteTarget.thumbnailUrl}`)).status,
      404
    );
    assert.equal(
      (await fetch(`${server.url}${deleteTarget.contactSheetUrl}`)).status,
      404
    );

    const artifact = {
      ok: true,
      url: server.url,
      processing: snapshot.processing,
      catalog: snapshot.catalog,
      pagination: {
        firstPage: firstPage.catalog,
        clampedFilteredPage: clampedPage.catalog
      },
      stickerCount: snapshot.stickers.length,
      queuedJobId: queued.id,
      queuedRetry: snapshot.jobs.find((job) => job.id === queued.id),
      failedJobId: failed.id,
      assetHeaders: {
        contentType: assetResponse.headers.get("content-type"),
        noSniff: assetResponse.headers.get("x-content-type-options"),
        csp: assetResponse.headers.get("content-security-policy")
      },
      sseCatalogUpdateObserved: true,
      sseSummaryOnlyObserved: true,
      management: {
        batchRebuild: {
          requested: rebuildResult.requested,
          succeeded: rebuildResult.succeeded,
          analyzerCallCount,
          descriptionsChanged: true,
          rowCount: rebuiltSnapshot.embedding.rowCount
        },
        singleDelete: {
          stickerId: deleteTarget.id,
          outcome: deleteResult.results[0]?.outcome,
          catalogTotal: snapshotAfterDelete.catalog.total,
          rowCount: snapshotAfterDelete.embedding.rowCount,
          mediaRemoved: true
        },
        invalidRequestRejected: true,
        crossOriginMutationRejected: true
      },
      legacySnapshotRemoved: true,
      allInterfacesBindingAllowed: true,
      crossOriginRejected: true
    };
    await mkdir(artifactDir, { recursive: true });
    await writeArtifactJson(path.join(artifactDir, "summary.json"), artifact);
    console.log(JSON.stringify({ ...artifact, hold }, null, 2));

    if (hold) {
      await service.observe(
        stickerEvent("live-restored-animated", "mface", animatedImage, "mface")
      );
      await service.whenIdle();
      await waitForShutdown();
    }
  } finally {
    await server.close();
    runStore.dispose();
  }
} finally {
  await rm(tempHome, { recursive: true, force: true });
}

function stickerEvent(
  id: string,
  sourceKind: "image" | "mface",
  bytes: Uint8Array,
  segmentType: "image" | "mface"
): MessageReceivedEvent {
  const encoded = `base64://${Buffer.from(bytes).toString("base64")}`;
  return {
    id,
    type: "MessageReceived",
    occurredAt: "2026-07-11T12:00:00.000Z",
    source: { platform: "qq", connector: "onebot-v11" },
    conversation: { kind: "group", id: "live-stickers-group" },
    sender: { id: "fixture-user", displayName: "Alice" },
    message: {
      id: `message-${id}`,
      text: "[表情包]",
      mentionsBot: false,
      sourceContent: {
        format: "onebot-v11",
        segments: [
          segmentType === "mface"
            ? {
                type: "mface",
                data: {
                  url: encoded,
                  emoji_id: `emoji-${sourceKind}`,
                  emoji_package_id: "live-fixture",
                  key: "private-fixture-key",
                  summary: "[动画表情]"
                }
              }
            : {
                type: "image",
                data: { file: encoded, sub_type: 1 }
              }
        ]
      }
    }
  };
}

function onlyObservation(event: MessageReceivedEvent) {
  const observations = extractStickerObservations(event);
  assert.equal(observations.length, 1);
  return observations[0]!;
}

async function createStaticImage(): Promise<Buffer> {
  return sharp({
    create: {
      width: 120,
      height: 90,
      channels: 4,
      background: { r: 221, g: 74, b: 76, alpha: 1 }
    }
  })
    .png()
    .toBuffer();
}

async function createAnimatedImage(): Promise<Buffer> {
  const width = 32;
  const height = 24;
  const frames = 18;
  const pixels = Buffer.alloc(width * height * frames * 4);
  for (let frame = 0; frame < frames; frame += 1) {
    for (let pixel = 0; pixel < width * height; pixel += 1) {
      const offset = (frame * width * height + pixel) * 4;
      pixels[offset] = 40 + frame * 8;
      pixels[offset + 1] = 80 + (pixel % 80);
      pixels[offset + 2] = 220;
      pixels[offset + 3] = 255;
    }
  }
  return sharp(pixels, {
    raw: { width, height: height * frames, channels: 4, pageHeight: height }
  })
    .gif({ delay: Array.from({ length: frames }, () => 80), loop: 0 })
    .toBuffer();
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  needle: string
): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const next = await reader.read();
    if (next.done) {
      break;
    }
    text += decoder.decode(next.value, { stream: true });
    if (text.includes(needle)) {
      return text;
    }
  }
  throw new Error(`Timed out waiting for SSE event ${needle}.`);
}

async function findAvailablePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

function waitForShutdown(): Promise<void> {
  return new Promise((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
}
