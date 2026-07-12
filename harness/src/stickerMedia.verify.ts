import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import {
  StickerJobSchema,
  STICKER_MEDIA_LIMITS,
  createMockConnector,
  createOneBotConnector,
  createStickerMediaResolver,
  extractStickerObservations,
  prepareStickerMedia,
  type ConnectorFetchedSegment,
  type MessageReceivedEvent,
  type StickerJob
} from "@gestalt/app";
import sharp from "sharp";

async function main(): Promise<void> {
  const inline = Buffer.from("safe-inline-sticker");
  const inlineConnector = createMockConnector();
  const inlineResolver = createStickerMediaResolver({
    connector: inlineConnector,
    fetch: rejectingFetch
  });
  assert.deepEqual(
    await inlineResolver.resolve(
      stickerJob({
        segmentIndex: 2,
        segment: {
          type: "image",
          data: {
            file: `base64://${inline.toString("base64")}`,
            sub_type: 1
          }
        }
      })
    ),
    inline
  );
  assert.equal(inlineConnector.calls.length, 0);

  const target = Buffer.from("target-mface-media");
  const decoy = Buffer.from("wrong-first-media");
  const fetchedConnector = createMockConnector();
  const fetchedSegments: ConnectorFetchedSegment[] = [
    fetchedMface(0, "emoji-decoy", "https://media.example/decoy"),
    fetchedMface(1, "emoji-target", "https://media.example/target")
  ];
  fetchedConnector.fetchMessage = async () => ({
    ok: true,
    segments: fetchedSegments
  });
  const fetchedUrls: string[] = [];
  const fetchedResolver = createStickerMediaResolver({
    connector: fetchedConnector,
    fetch: async (request) => {
      const url = String(request);
      fetchedUrls.push(url);
      return new Response(url.endsWith("/target") ? target : decoy, {
        status: 200
      });
    }
  });
  const selected = await fetchedResolver.resolve(
    stickerJob({
      sourceKind: "mface",
      segmentIndex: 1,
      segment: {
        type: "mface",
        data: {
          emoji_id: "emoji-target",
          emoji_package_id: "package-a",
          key: "target-key"
        }
      }
    })
  );
  assert.deepEqual(Buffer.from(selected), target);
  assert.deepEqual(fetchedUrls, ["https://media.example/target"]);

  const reorderedConnector = createMockConnector();
  reorderedConnector.fetchMessage = async () => ({
    ok: true,
    segments: [
      fetchedMface(0, "emoji-target", "https://media.example/reordered-target"),
      fetchedMface(1, "emoji-decoy", "https://media.example/reordered-decoy")
    ]
  });
  const reorderedUrls: string[] = [];
  const reorderedResolver = createStickerMediaResolver({
    connector: reorderedConnector,
    fetch: async (request) => {
      reorderedUrls.push(String(request));
      return new Response(target, { status: 200 });
    }
  });
  assert.deepEqual(
    Buffer.from(await reorderedResolver.resolve(
      stickerJob({
        sourceKind: "mface",
        segmentIndex: 1,
        segment: {
          type: "mface",
          data: {
            emoji_id: "emoji-target",
            emoji_package_id: "package-a",
            key: "target-key"
          }
        }
      })
    )),
    target
  );
  assert.deepEqual(reorderedUrls, ["https://media.example/reordered-target"]);

  const unsafeConnector = createMockConnector();
  unsafeConnector.readImage = async (input) => ({
    ok: true,
    data: {
      file: input.file,
      url: "https://untrusted-inbound.example/secret"
    }
  });
  unsafeConnector.fetchMessage = async () => ({ ok: false });
  let unsafeFetchCalls = 0;
  const unsafeResolver = createStickerMediaResolver({
    connector: unsafeConnector,
    fetch: async () => {
      unsafeFetchCalls += 1;
      return new Response("must-not-be-read");
    }
  });
  await assert.rejects(
    unsafeResolver.resolve(
      stickerJob({
        segmentIndex: 0,
        segment: {
          type: "image",
          data: {
            file: path.resolve("private-host-file.png"),
            path: path.resolve("private-host-file.png"),
            url: "https://untrusted-inbound.example/secret",
            sub_type: 1
          }
        }
      })
    ),
    /could not be resolved/
  );
  assert.equal(unsafeFetchCalls, 0);

  const trustedConnector = createMockConnector();
  trustedConnector.readImage = async () => ({
    ok: true,
    media: {
      source: "connector-action",
      kind: "https-url",
      value: "https://198.18.0.1/sticker"
    }
  });
  let trustedFetchCalls = 0;
  const trustedResolver = createStickerMediaResolver({
    connector: trustedConnector,
    fetch: async () => {
      trustedFetchCalls += 1;
      return new Response(target, { status: 200 });
    }
  });
  assert.deepEqual(
    Buffer.from(await trustedResolver.resolve(opaqueImageJob())),
    target
  );
  assert.equal(trustedFetchCalls, 1);

  const oversizedConnector = createMockConnector();
  oversizedConnector.readImage = trustedConnector.readImage;
  const nineMiB = new Uint8Array(9 * 1024 * 1024);
  const oversizedResolver = createStickerMediaResolver({
    connector: oversizedConnector,
    fetch: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(nineMiB);
            controller.enqueue(nineMiB);
            controller.close();
          }
        }),
        { status: 200 }
      )
  });
  await assert.rejects(
    oversizedResolver.resolve(opaqueImageJob()),
    /exceeds 16777216 bytes/
  );

  const oversizedDimensionError = await rejectionMessage(
    prepareStickerMedia(
      await createStaticPng(STICKER_MEDIA_LIMITS.maxDimension + 1, 1)
    ),
    new RegExp(
      `width ${STICKER_MEDIA_LIMITS.maxDimension + 1} exceeds ${STICKER_MEDIA_LIMITS.maxDimension} pixels`
    )
  );
  const oversizedHeightError = await rejectionMessage(
    prepareStickerMedia(
      await createStaticPng(1, STICKER_MEDIA_LIMITS.maxDimension + 1)
    ),
    new RegExp(
      `height ${STICKER_MEDIA_LIMITS.maxDimension + 1} exceeds ${STICKER_MEDIA_LIMITS.maxDimension} pixels`
    )
  );

  const oversizedPixelSide =
    Math.floor(Math.sqrt(STICKER_MEDIA_LIMITS.maxFramePixels)) + 1;
  const oversizedFramePixelsError = await rejectionMessage(
    prepareStickerMedia(
      await createStaticPng(oversizedPixelSide, oversizedPixelSide)
    ),
    new RegExp(
      `frame pixels \\d+ exceeds ${STICKER_MEDIA_LIMITS.maxFramePixels}`
    )
  );

  const excessiveFrameCount = STICKER_MEDIA_LIMITS.maxFrameCount + 1;
  const excessiveFrameCountError = await rejectionMessage(
    prepareStickerMedia(await createAnimatedGif(2, 2, excessiveFrameCount)),
    new RegExp(
      `frame count ${excessiveFrameCount} exceeds ${STICKER_MEDIA_LIMITS.maxFrameCount}`
    )
  );

  const totalPixelFrameSize = 1_024;
  const excessiveTotalFrameCount =
    Math.floor(
      STICKER_MEDIA_LIMITS.maxTotalAnimationPixels /
        (totalPixelFrameSize * totalPixelFrameSize)
    ) + 1;
  const totalPixelFixture = patchGifLogicalSize(
    await createAnimatedGif(2, 2, excessiveTotalFrameCount),
    totalPixelFrameSize,
    totalPixelFrameSize
  );
  const excessiveTotalPixelsError = await rejectionMessage(
    prepareStickerMedia(totalPixelFixture),
    new RegExp(
      `animation pixels \\d+ exceeds ${STICKER_MEDIA_LIMITS.maxTotalAnimationPixels}`
    )
  );

  const validAnimationFrameCount = 20;
  const validAnimation = await prepareStickerMedia(
    await createAnimatedGif(64, 64, validAnimationFrameCount)
  );
  assert.equal(validAnimation.frameCount, validAnimationFrameCount);
  assert.equal(validAnimation.animated, true);
  assert.ok(validAnimation.contactSheet);
  const validContactSheetMetadata = await sharp(
    validAnimation.contactSheet
  ).metadata();
  assert.equal(validContactSheetMetadata.width, 1_024);
  assert.equal(validContactSheetMetadata.height, 1_024);

  const observations = extractStickerObservations(multiSegmentEvent());
  assert.deepEqual(
    observations.map((observation) => observation.segmentIndex),
    [1, 3]
  );

  const actionConnector = createOneBotConnector({
    caller: {
      async callAction(action, params) {
        if (action === "get_msg") {
          return {
            ok: true,
            data: {
              message_id: 42,
              message: [
                { type: "text", data: { text: "x" } },
                {
                  type: "mface",
                  data: {
                    emoji_id: "emoji-action",
                    emoji_package_id: "package-action",
                    key: "action-key",
                    url: "https://media.example/action"
                  }
                }
              ]
            }
          };
        }
        const requestedFile = String(params?.file ?? "");
        return {
          ok: true,
          data: {
            file:
              requestedFile === "echo-absolute-token"
                ? requestedFile
                : "/connector/cache/sticker.png"
          }
        };
      }
    }
  });
  const actionMessage = await actionConnector.fetchMessage({ messageId: "42" });
  assert.equal(actionMessage.segments?.[1]?.segmentIndex, 1);
  assert.deepEqual(actionMessage.segments?.[1]?.media, {
    source: "connector-action",
    kind: "https-url",
    value: "https://media.example/action"
  });
  const actionImage = await actionConnector.readImage({ file: "opaque-token" });
  assert.deepEqual(actionImage.media, {
    source: "connector-action",
    kind: "local-file",
    value: "/connector/cache/sticker.png"
  });
  const echoedImage = await actionConnector.readImage({
    file: "echo-absolute-token"
  });
  assert.equal(echoedImage.media, undefined);

  const summary = {
    inlineBytes: inline.byteLength,
    segmentIndices: observations.map((observation) => observation.segmentIndex),
    selectedUrl: fetchedUrls[0],
    reorderedFallbackUrl: reorderedUrls[0],
    unsafeInboundFetchCalls: unsafeFetchCalls,
    trustedConnectorFetchCalls: trustedFetchCalls,
    streamLimitBytes: 16 * 1024 * 1024,
    connectorMediaKind: actionMessage.segments?.[1]?.media?.kind,
    mediaLimits: STICKER_MEDIA_LIMITS,
    decodeBudgetRejections: {
      dimensions: {
        width: oversizedDimensionError,
        height: oversizedHeightError
      },
      framePixels: oversizedFramePixelsError,
      frameCount: excessiveFrameCountError,
      totalAnimationPixels: excessiveTotalPixelsError
    },
    validAnimation: {
      sourceFrames: validAnimation.frameCount,
      sampledFrames: 16,
      layout: "4x4",
      width: validContactSheetMetadata.width,
      height: validContactSheetMetadata.height
    }
  };
  const repoRoot = path.resolve(import.meta.dirname, "../..");
  const artifactDir = path.join(repoRoot, "harness", "artifacts", "sticker-media-security");
  await mkdir(artifactDir, { recursive: true });
  await writeFile(
    path.join(artifactDir, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
    "utf8"
  );
  console.log(JSON.stringify(summary, null, 2));
}

function fetchedMface(
  segmentIndex: number,
  emojiId: string,
  url: string
): ConnectorFetchedSegment {
  return {
    segmentIndex,
    type: "mface",
    data: {
      emoji_id: emojiId,
      emoji_package_id: "package-a",
      key: emojiId === "emoji-target" ? "target-key" : "decoy-key"
    },
    media: {
      source: "connector-action",
      kind: "https-url",
      value: url
    }
  };
}

function opaqueImageJob(): StickerJob {
  return stickerJob({
    segmentIndex: 0,
    segment: {
      type: "image",
      data: { file: "opaque-image-token", sub_type: 1 }
    }
  });
}

function stickerJob(input: {
  sourceKind?: "mface" | "image";
  segmentIndex: number;
  segment: { type: string; data: Record<string, unknown> };
}): StickerJob {
  return StickerJobSchema.parse({
    id: "fixture-job",
    status: "queued",
    sourceKind: input.sourceKind ?? "image",
    eventId: "fixture-event",
    messageId: "fixture-message",
    conversation: { kind: "group", id: "fixture-group" },
    senderId: "fixture-user",
    occurredAt: "2026-07-11T00:00:00.000Z",
    segmentIndex: input.segmentIndex,
    segment: input.segment,
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z",
    attempts: 0
  });
}

function multiSegmentEvent(): MessageReceivedEvent {
  return {
    id: "multi-segment-event",
    type: "MessageReceived",
    occurredAt: "2026-07-11T00:00:00.000Z",
    source: { platform: "qq", connector: "onebot-v11" },
    conversation: { kind: "group", id: "fixture-group" },
    sender: { id: "fixture-user" },
    message: {
      id: "multi-segment-message",
      text: "two stickers",
      mentionsBot: false,
      sourceContent: {
        format: "onebot-v11",
        segments: [
          { type: "text", data: { text: "a" } },
          { type: "image", data: { file: "one", sub_type: 1 } },
          { type: "text", data: { text: "b" } },
          {
            type: "mface",
            data: {
              emoji_id: "two",
              emoji_package_id: "package",
              key: "key"
            }
          }
        ]
      }
    }
  };
}

async function rejectingFetch(): Promise<Response> {
  throw new Error("Unexpected network fetch.");
}

async function createStaticPng(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 20, g: 40, b: 60, alpha: 1 }
    }
  })
    .png()
    .toBuffer();
}

async function createAnimatedGif(
  width: number,
  height: number,
  frameCount: number
): Promise<Buffer> {
  const pixels = Buffer.alloc(width * height * frameCount * 4);
  const framePixels = width * height;
  for (let frame = 0; frame < frameCount; frame += 1) {
    for (let pixel = 0; pixel < framePixels; pixel += 1) {
      const offset = (frame * framePixels + pixel) * 4;
      pixels[offset] = frame % 256;
      pixels[offset + 1] = (frame * 17 + pixel) % 256;
      pixels[offset + 2] = (frame * 31 + pixel) % 256;
      pixels[offset + 3] = 255;
    }
  }
  return sharp(pixels, {
    raw: {
      width,
      height: height * frameCount,
      channels: 4,
      pageHeight: height
    }
  })
    .gif({ delay: Array.from({ length: frameCount }, () => 50), loop: 0 })
    .toBuffer();
}

function patchGifLogicalSize(
  input: Buffer,
  width: number,
  height: number
): Buffer {
  assert.match(input.subarray(0, 6).toString("ascii"), /^GIF8[79]a$/);
  const output = Buffer.from(input);
  output.writeUInt16LE(width, 6);
  output.writeUInt16LE(height, 8);
  return output;
}

async function rejectionMessage(
  promise: Promise<unknown>,
  expected: RegExp
): Promise<string> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error, "Expected sticker media preparation to fail.");
  assert.match(caught.message, expected);
  return caught.message;
}

await main();
