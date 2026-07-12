import assert from "node:assert/strict";
import path from "node:path";
import {
  access,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  createBinarySanitizer,
  DEFAULT_MAX_TRACE_BLOB_BYTES,
  traceBlobPath
} from "./binary";
import { resolveTraceBinaryCaptureEnabled } from "./config";
import { createRolloutReader } from "./reader";
import { snapshotStepRequest } from "../model/aiSdkModel";
import type {
  BinaryDescriptor,
  RolloutTerminalStatus
} from "./types";
import { createRolloutWriter } from "./writer";

const IMAGE_BYTES = 123_652;
const BASE_TIME = new Date("2026-07-12T12:00:00.000Z");

async function main(): Promise<void> {
  await verifyBinaryCaptureBoundary();
  await verifyEmbeddedBinaryAndErrorRedaction();
  await verifyPreSerializedStructuredBinary();
  await verifyDefaultBlobLimit();
  await verifyCancelledStateAndReconstruction();
  await verifyRestartDerivation();
  await verifyCursorSearchAndStatus();
  verifyConfigDefault();

  console.log(
    JSON.stringify(
      {
        ok: true,
        imageBytes: IMAGE_BYTES,
        maxBlobBytes: DEFAULT_MAX_TRACE_BLOB_BYTES
      },
      null,
      2
    )
  );
}

async function verifyPreSerializedStructuredBinary(): Promise<void> {
  const temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "gestalt-rollout-structured-binary-")
  );
  try {
    const bytes = patternedBytes(257);
    const encoded = bytes.toString("base64");
    const request = snapshotStepRequest(
      {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "file",
                mediaType: "image/png",
                data: new Uint8Array(
                  bytes.buffer,
                  bytes.byteOffset,
                  bytes.byteLength
                )
              },
              {
                type: "image",
                mediaType: "image/png",
                image: encoded
              }
            ]
          }
        ]
      },
      {
        providerName: "fixture",
        modelName: "fixture-model",
        temperature: 0
      }
    );
    const snapshotContent = request.messages[0]?.content ?? "";
    const snapshotText = JSON.stringify(snapshotContent);
    assert.equal(snapshotText.includes('"0":'), false);
    assert.equal(snapshotText.includes('"type":"binary_source"'), true);

    const serializedTypedArray = JSON.stringify({
      type: "file",
      mediaType: "image/png",
      data: Object.fromEntries(
        [...bytes].map((value, index) => [String(index), value])
      )
    });
    const hintedBareBase64 = JSON.stringify({
      type: "image",
      mediaType: "image/png",
      image: encoded
    });
    const disabled = createBinarySanitizer({
      tracesDir: path.join(temporaryDirectory, "disabled", "traces"),
      captureEnabled: false
    });
    const disabledValue = await disabled.sanitize({
      snapshotContent,
      serializedTypedArray,
      hintedBareBase64
    });
    const disabledText = JSON.stringify(disabledValue);
    const disabledDescriptors = collectBinaryDescriptors(disabledValue);
    assert.equal(disabledDescriptors.length, 4);
    assert.ok(
      disabledDescriptors.every(
        (descriptor) => descriptor.availability === "not_captured"
      )
    );
    assert.equal(disabledText.includes(encoded), false);
    assert.equal(disabledText.includes('"0":'), false);
    assert.equal(disabledText.includes('"data":['), false);

    const enabledTraces = path.join(temporaryDirectory, "enabled", "traces");
    const enabled = createBinarySanitizer({
      tracesDir: enabledTraces,
      captureEnabled: true
    });
    const enabledValue = await enabled.sanitize({
      snapshotContent,
      serializedTypedArray,
      hintedBareBase64
    });
    const enabledDescriptors = collectBinaryDescriptors(enabledValue);
    assert.equal(enabledDescriptors.length, 4);
    assert.ok(
      enabledDescriptors.every(
        (descriptor) => descriptor.availability === "stored"
      )
    );
    const hashes = new Set(enabledDescriptors.map((descriptor) => descriptor.sha256));
    assert.equal(hashes.size, 1);
    const [sha256] = hashes;
    assert.ok(sha256);
    assert.equal((await stat(traceBlobPath(enabledTraces, sha256))).size, bytes.length);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function verifyEmbeddedBinaryAndErrorRedaction(): Promise<void> {
  const temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "gestalt-rollout-redaction-")
  );
  try {
    const bytes = Buffer.from("embedded-pdf", "utf8");
    const sanitizer = createBinarySanitizer({
      tracesDir: path.join(temporaryDirectory, "traces"),
      captureEnabled: false
    });
    const sanitized = await sanitizer.sanitize({
      embedded: `prefix data:application/pdf;base64,${bytes.toString("base64")} suffix`,
      dataPreview: JSON.stringify({
        file: "/mock/onebot/image/cat.png",
        raw: { path: "/run/gestalt/transient/image.png" }
      }),
      toolProtocol: {
        inputSchema: {
          properties: {
            file: { type: "string" },
            url: { type: "string" }
          }
        }
      },
      connectorLocator: {
        file: "cat.png",
        path: "relative/private/image.png"
      },
      error: new Error(
        "failed at C:\\private\\capture.bin https://example.invalid/blob?token=secret"
      )
    });
    const text = JSON.stringify(sanitized);
    assert.equal(text.includes(bytes.toString("base64")), false);
    assert.equal(text.includes("application/pdf"), true);
    assert.equal(text.includes("C:\\\\private"), false);
    assert.equal(text.includes("/mock/onebot"), false);
    assert.equal(text.includes("/run/gestalt"), false);
    assert.equal(text.includes('"file":{"type":"string"}'), true);
    assert.equal(text.includes('"file":"cat.png"'), true);
    assert.equal(text.includes("relative/private/image.png"), false);
    assert.equal(text.includes("token=secret"), false);
    assert.equal(text.includes("[PATH]"), true);
    assert.equal(text.includes("[TEMP_URL]"), true);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function verifyBinaryCaptureBoundary(): Promise<void> {
  const temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "gestalt-rollout-binary-")
  );
  try {
    const bytes = patternedBytes(IMAGE_BYTES);
    const disabledTraces = path.join(temporaryDirectory, "disabled", "traces");
    const disabled = await writeBinaryRollout({
      tracesDir: disabledTraces,
      rolloutId: "binary-disabled",
      captureEnabled: false,
      bytes,
      startedAt: timestamp(0)
    });
    assert.equal(disabled.descriptors.length, 6);
    assert.ok(
      disabled.descriptors.every(
        (descriptor) => descriptor.availability === "not_captured"
      )
    );
    assert.equal(new Set(disabled.descriptors.map(({ sha256 }) => sha256)).size, 1);
    assert.equal(await exists(path.join(disabledTraces, "blobs")), false);
    assertSafeJson(disabled.raw);

    const enabledTraces = path.join(temporaryDirectory, "enabled", "traces");
    const enabled = await writeBinaryRollout({
      tracesDir: enabledTraces,
      rolloutId: "binary-enabled-1",
      captureEnabled: true,
      bytes,
      startedAt: timestamp(1)
    });
    assert.equal(enabled.descriptors.length, 6);
    assert.ok(
      enabled.descriptors.every(
        (descriptor) => descriptor.availability === "stored"
      )
    );
    const hashes = new Set(enabled.descriptors.map(({ sha256 }) => sha256));
    assert.equal(hashes.size, 1);
    const sha256 = enabled.descriptors[0]?.sha256;
    assert.ok(sha256);

    // A second rollout referencing the same bytes must reuse the same blob.
    await writeBinaryRollout({
      tracesDir: enabledTraces,
      rolloutId: "binary-enabled-2",
      captureEnabled: true,
      bytes,
      startedAt: timestamp(2),
      compactPayload: true
    });
    const blobPath = traceBlobPath(enabledTraces, sha256);
    assert.equal((await stat(blobPath)).size, IMAGE_BYTES);
    assert.deepEqual(await readFile(blobPath), bytes);
    assert.deepEqual(await readdir(path.dirname(blobPath)), [sha256]);
    assertSafeJson(enabled.raw);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function verifyDefaultBlobLimit(): Promise<void> {
  const temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "gestalt-rollout-limit-")
  );
  try {
    assert.equal(DEFAULT_MAX_TRACE_BLOB_BYTES, 16 * 1024 * 1024);
    const tracesDir = path.join(temporaryDirectory, "traces");
    const sanitizer = createBinarySanitizer({
      tracesDir,
      captureEnabled: true
    });
    const exactBytes = Buffer.alloc(DEFAULT_MAX_TRACE_BLOB_BYTES, 0xa5);
    const exact = await sanitizer.capture(exactBytes);
    assert.equal(exact.availability, "stored");
    assert.equal(
      (await stat(traceBlobPath(tracesDir, exact.sha256))).size,
      DEFAULT_MAX_TRACE_BLOB_BYTES
    );

    const oversizedBytes = Buffer.alloc(DEFAULT_MAX_TRACE_BLOB_BYTES + 1, 0x5a);
    const oversized = await sanitizer.capture(oversizedBytes);
    assert.equal(oversized.availability, "size_limit_exceeded");
    assert.equal(
      await exists(traceBlobPath(tracesDir, oversized.sha256)),
      false
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function verifyCancelledStateAndReconstruction(): Promise<void> {
  const temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "gestalt-rollout-state-")
  );
  try {
    const tracesDir = path.join(temporaryDirectory, "traces");
    const rolloutId = "state-reconstruction";
    const writer = await createRolloutWriter({
      tracesDir,
      rolloutId,
      activeLoopId: rolloutId,
      startedAt: timestamp(10),
      now: () => new Date(timestamp(20))
    });
    await writer.append({
      id: "state-start",
      rolloutId,
      timestamp: timestamp(10),
      type: "rollout_started",
      activeLoopId: rolloutId,
      conversationKey: "group:state"
    });
    await writer.append({
      id: "state-init",
      rolloutId,
      timestamp: timestamp(11),
      type: "model_session_initialized",
      messages: [{ id: "initial", role: "system", content: "system" }],
      tools: [{ name: "send_group_message" }]
    });
    const initialStateHash = writer.stateHash;
    assert.ok(initialStateHash);
    assert.equal(writer.messageCount, 1);

    await writer.append({
      id: "generation-cancelled-record",
      rolloutId,
      timestamp: timestamp(12),
      type: "generation_completed",
      generationId: "generation-cancelled",
      outputMessageIds: [],
      status: "cancelled"
    });
    assert.equal(writer.stateHash, initialStateHash);
    assert.equal(writer.messageCount, 1);

    await writer.append({
      id: "state-user-record",
      rolloutId,
      timestamp: timestamp(13),
      type: "message_committed",
      message: { id: "user", role: "user", content: "hello" },
      source: "user"
    });
    const completedInputHash = writer.stateHash;
    assert.ok(completedInputHash);
    assert.notEqual(completedInputHash, initialStateHash);
    await writer.append({
      id: "generation-completed-record",
      rolloutId,
      timestamp: timestamp(14),
      type: "generation_completed",
      generationId: "generation-completed",
      outputMessageIds: ["assistant"],
      status: "completed",
      cacheUsage: { readTokens: 42 }
    });
    await writer.append({
      id: "state-assistant-record",
      rolloutId,
      timestamp: timestamp(15),
      type: "message_committed",
      message: { id: "assistant", role: "assistant", content: "hi" },
      source: "assistant"
    });
    assert.notEqual(writer.stateHash, completedInputHash);
    await writer.close("completed");

    const reader = createRolloutReader({ tracesDir });
    const cancelled = await reader.reconstructInput(
      rolloutId,
      "generation-cancelled"
    );
    assert.equal(cancelled.stateHash, initialStateHash);
    assert.deepEqual(cancelled.messages.map(({ id }) => id), ["initial"]);

    const completed = await reader.reconstructInput(
      rolloutId,
      "generation-completed"
    );
    assert.equal(completed.stateHash, completedInputHash);
    assert.deepEqual(completed.messages.map(({ id }) => id), ["initial", "user"]);
    assert.deepEqual(completed.tools, [{ name: "send_group_message" }]);

    const detail = await reader.read(rolloutId);
    assert.equal(detail.summary.status, "completed");
    assert.equal(detail.summary.generationCount, 2);
    assert.equal(detail.summary.messageCount, 3);
    assert.equal(detail.truncatedTail, false);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function verifyRestartDerivation(): Promise<void> {
  const temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "gestalt-rollout-restart-")
  );
  try {
    const tracesDir = path.join(temporaryDirectory, "traces");
    const rolloutId = "unfinished-outbound";
    const writer = await createRolloutWriter({
      tracesDir,
      rolloutId,
      activeLoopId: rolloutId,
      startedAt: timestamp(30),
      now: () => new Date(timestamp(35))
    });
    await writer.append({
      id: "restart-start",
      rolloutId,
      timestamp: timestamp(30),
      type: "rollout_started",
      activeLoopId: rolloutId,
      conversationKey: "group:restart"
    });
    await writer.append({
      id: "outbound-start",
      rolloutId,
      timestamp: timestamp(31),
      type: "outbound_action_started",
      actionId: "send-1",
      toolName: "send_group_message",
      params: { text: "possibly sent" }
    });
    await writer.flush({ durable: true });

    const detail = await createRolloutReader({ tracesDir }).read(rolloutId);
    assert.equal(detail.summary.status, "failed");
    assert.equal(detail.summary.failureReason, "process_restarted");
    assert.deepEqual(detail.unresolvedOutboundActions, [
      {
        actionId: "send-1",
        toolName: "send_group_message",
        startedAt: timestamp(31),
        status: "failed",
        reason: "result_unknown_after_restart"
      }
    ]);

    // Close only to release this verification process's file handle. The
    // assertions above intentionally observed the durable unfinished state.
    await writer.close("cancelled");
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function verifyCursorSearchAndStatus(): Promise<void> {
  const temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "gestalt-rollout-list-")
  );
  try {
    const tracesDir = path.join(temporaryDirectory, "traces");
    await writeMinimalRollout(
      tracesDir,
      "rollout-old",
      "Needle old",
      "completed",
      40
    );
    await writeMinimalRollout(
      tracesDir,
      "rollout-middle",
      "Other",
      "completed",
      41
    );
    await writeMinimalRollout(
      tracesDir,
      "rollout-failed",
      "Needle new",
      "failed",
      42
    );
    await writeMinimalRollout(
      tracesDir,
      "rollout-newest",
      "Newest",
      "completed",
      43
    );

    const reader = createRolloutReader({ tracesDir });
    const firstPage = await reader.list({ limit: 2 });
    assert.deepEqual(firstPage.items.map(({ id }) => id), [
      "rollout-newest",
      "rollout-failed"
    ]);
    assert.ok(firstPage.nextCursor);
    const secondPage = await reader.list({
      limit: 2,
      cursor: firstPage.nextCursor
    });
    assert.deepEqual(secondPage.items.map(({ id }) => id), [
      "rollout-middle",
      "rollout-old"
    ]);
    assert.equal(secondPage.nextCursor, undefined);

    const firstSearchPage = await reader.list({ query: "needle", limit: 1 });
    assert.deepEqual(firstSearchPage.items.map(({ id }) => id), [
      "rollout-failed"
    ]);
    assert.ok(firstSearchPage.nextCursor);
    const secondSearchPage = await reader.list({
      query: "needle",
      limit: 1,
      cursor: firstSearchPage.nextCursor
    });
    assert.deepEqual(secondSearchPage.items.map(({ id }) => id), [
      "rollout-old"
    ]);

    const failed = await reader.list({ status: "failed" });
    assert.deepEqual(failed.items.map(({ id }) => id), ["rollout-failed"]);
    assert.equal(failed.items[0]?.failureReason, "fixture_failure");
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function writeBinaryRollout(input: {
  tracesDir: string;
  rolloutId: string;
  captureEnabled: boolean;
  bytes: Buffer;
  startedAt: string;
  compactPayload?: boolean;
}): Promise<{ raw: string; descriptors: BinaryDescriptor[] }> {
  const writer = await createRolloutWriter({
    tracesDir: input.tracesDir,
    rolloutId: input.rolloutId,
    activeLoopId: input.rolloutId,
    binaryCaptureEnabled: input.captureEnabled,
    startedAt: input.startedAt,
    now: () => new Date(input.startedAt)
  });
  await writer.append({
    id: `${input.rolloutId}-start`,
    rolloutId: input.rolloutId,
    timestamp: input.startedAt,
    type: "rollout_started",
    activeLoopId: input.rolloutId
  });
  await writer.append({
    id: `${input.rolloutId}-init`,
    rolloutId: input.rolloutId,
    timestamp: input.startedAt,
    type: "model_session_initialized",
    messages: [
      {
        id: `${input.rolloutId}-message`,
        role: "user",
        content: input.compactPayload
          ? input.bytes
          : binaryPayload(input.bytes)
      }
    ],
    tools: []
  });
  await writer.close("completed");

  const raw = await readFile(writer.filePath, "utf8");
  const detail = await createRolloutReader({
    tracesDir: input.tracesDir
  }).read(input.rolloutId);
  const initialized = detail.records.find(
    (record) => record.type === "model_session_initialized"
  );
  assert.ok(initialized?.type === "model_session_initialized");
  return {
    raw,
    descriptors: collectBinaryDescriptors(initialized.messages[0]?.content)
  };
}

function binaryPayload(bytes: Buffer): unknown {
  const typedArray = new Uint8Array(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength
  );
  const arrayBuffer = Uint8Array.from(bytes).buffer;
  return {
    mediaType: "image/png",
    buffer: bytes,
    typedArray,
    arrayBuffer,
    dataUri: `data:image/png;base64,${bytes.toString("base64")}`,
    nested: {
      mimeType: "image/png",
      media: bytes
    },
    serializedBuffer: bytes.toJSON()
  };
}

function collectBinaryDescriptors(value: unknown): BinaryDescriptor[] {
  const descriptors: BinaryDescriptor[] = [];
  const pending = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== "object") {
      continue;
    }
    if (isBinaryDescriptor(current)) {
      descriptors.push(current);
      continue;
    }
    if (Array.isArray(current)) {
      pending.push(...current);
    } else {
      pending.push(...Object.values(current));
    }
  }
  return descriptors;
}

function isBinaryDescriptor(value: object): value is BinaryDescriptor {
  const record = value as Partial<BinaryDescriptor>;
  return (
    record.type === "binary" &&
    typeof record.mediaType === "string" &&
    typeof record.byteLength === "number" &&
    typeof record.sha256 === "string" &&
    typeof record.availability === "string"
  );
}

function assertSafeJson(raw: string): void {
  assert.equal(raw.includes('"type":"Buffer"'), false);
  assert.equal(raw.includes('"data":['), false);
  assert.equal(raw.includes('"0":'), false);
  assert.equal(raw.includes("data:image/"), false);
  assert.equal(raw.includes("base64://"), false);
  assert.equal(raw.includes('"seq"'), false);
  assert.equal(raw.includes('"version"'), false);
  assert.ok(Buffer.byteLength(raw, "utf8") < 10_000);
}

async function writeMinimalRollout(
  tracesDir: string,
  rolloutId: string,
  name: string,
  status: RolloutTerminalStatus,
  secondOffset: number
): Promise<void> {
  const startedAt = timestamp(secondOffset);
  const writer = await createRolloutWriter({
    tracesDir,
    rolloutId,
    activeLoopId: rolloutId,
    startedAt,
    now: () => new Date(startedAt)
  });
  await writer.append({
    id: `${rolloutId}-start`,
    rolloutId,
    timestamp: startedAt,
    type: "rollout_started",
    activeLoopId: rolloutId,
    name,
    conversationKey: `group:${rolloutId}`
  });
  await writer.close(
    status,
    status === "failed" ? { reason: "fixture_failure" } : {}
  );
}

function verifyConfigDefault(): void {
  assert.equal(resolveTraceBinaryCaptureEnabled(), false);
  assert.equal(resolveTraceBinaryCaptureEnabled({}), false);
  assert.equal(
    resolveTraceBinaryCaptureEnabled({
      trace_binary_capture_enabled: true
    }),
    true
  );
  assert.equal(
    resolveTraceBinaryCaptureEnabled({
      trace_binary_capture_enabled: "true"
    }),
    false
  );
}

function patternedBytes(length: number): Buffer {
  const bytes = Buffer.allocUnsafe(length);
  for (let index = 0; index < length; index += 1) {
    bytes[index] = index % 251;
  }
  return bytes;
}

function timestamp(secondOffset: number): string {
  return new Date(BASE_TIME.valueOf() + secondOffset * 1_000).toISOString();
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

await main();
