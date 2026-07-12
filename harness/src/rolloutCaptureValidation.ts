import assert from "node:assert/strict";
import {
  advanceStateHash,
  computeInitialStateHash,
  createBinarySanitizer,
  createRolloutReader,
  type ReconstructedInput,
  type RolloutDetail,
  type RolloutRecord
} from "@gestalt/app";
import type { ModelExchangeSnapshot } from "./modelExchangeCapture";

export interface ValidatedRolloutCapture {
  rollouts: RolloutDetail[];
  reconstructedInputs: ReconstructedInput[];
}

/**
 * Reads the production incremental records, replays every generation input,
 * and compares it with the harness-owned canonical request capture. The
 * production trace is never used as the source of the full model exchange.
 */
export async function readAndValidateRolloutCapture(
  tracesDir: string,
  modelExchanges: readonly ModelExchangeSnapshot[]
): Promise<ValidatedRolloutCapture> {
  const reader = createRolloutReader({ tracesDir });
  const page = await reader.list({ limit: 200 });
  const rollouts = await Promise.all(
    page.items.map((summary) => reader.read(summary.id))
  );
  const reconstructedInputs: ReconstructedInput[] = [];
  const generations: Array<
    Extract<RolloutRecord, { type: "generation_completed" }>
  > = [];

  assertIndependentStateHashes(rollouts);

  // The reader lists newest first; generation captures are chronological.
  for (const rollout of rollouts.slice().reverse()) {
    for (const record of rollout.records) {
      if (record.type === "generation_completed") {
        generations.push(record);
        reconstructedInputs.push(
          await reader.reconstructInput(
            rollout.summary.id,
            record.generationId
          )
        );
      }
    }
  }

  await assertReconstructedInputs(
    reconstructedInputs,
    modelExchanges,
    tracesDir
  );
  assertExchangeStatuses(generations, modelExchanges);
  return { rollouts, reconstructedInputs };
}

function assertIndependentStateHashes(
  rollouts: readonly RolloutDetail[]
): void {
  for (const rollout of rollouts) {
    let stateHash: string | undefined;
    let messageCount = 0;
    for (const record of rollout.records) {
      if (record.type === "model_session_initialized") {
        const expected = computeInitialStateHash(record.messages, record.tools);
        assert.equal(
          record.stateHash,
          expected,
          `rollout ${rollout.summary.id} initial state hash is not canonical`
        );
        stateHash = expected;
        messageCount = record.messages.length;
        continue;
      }
      if (record.type === "message_committed") {
        assert.ok(stateHash, "message commit must follow model initialization");
        assert.equal(record.previousStateHash, stateHash);
        const expected = advanceStateHash(stateHash, record.message);
        assert.equal(
          record.stateHash,
          expected,
          `rollout ${rollout.summary.id} committed state hash is not canonical`
        );
        stateHash = expected;
        messageCount += 1;
        continue;
      }
      if (record.type === "generation_completed") {
        assert.ok(stateHash, "generation must follow model initialization");
        assert.equal(
          record.inputStateHash,
          stateHash,
          `generation ${record.generationId} used a non-canonical prefix`
        );
        assert.equal(record.inputMessageCount, messageCount);
      }
    }
  }
}

function assertExchangeStatuses(
  generations: readonly Extract<
    RolloutRecord,
    { type: "generation_completed" }
  >[],
  modelExchanges: readonly ModelExchangeSnapshot[]
): void {
  assert.equal(
    generations.length,
    modelExchanges.length,
    "every harness exchange must retain its production generation status"
  );
  for (const [index, generation] of generations.entries()) {
    const exchange = modelExchanges[index];
    assert.ok(exchange, `missing captured exchange ${index}`);
    assert.equal(
      generation.status,
      exchange.status,
      `generation ${generation.generationId} status diverged from harness capture`
    );
    if (exchange.response === undefined) {
      assert.deepEqual(
        generation.outputMessageIds,
        [],
        `generation ${generation.generationId} invented output without a provider response`
      );
      assert.equal(generation.finishReason, undefined);
      assert.equal(generation.usage, undefined);
    }
  }
}

async function assertReconstructedInputs(
  reconstructedInputs: readonly ReconstructedInput[],
  modelExchanges: readonly ModelExchangeSnapshot[],
  tracesDir: string
): Promise<void> {
  if (modelExchanges.length === 0 && reconstructedInputs.length === 0) {
    return;
  }
  assert.equal(
    reconstructedInputs.length,
    modelExchanges.length,
    "every captured model request must have one reconstructable rollout generation"
  );
  const sanitizer = createBinarySanitizer({
    tracesDir,
    captureEnabled: false
  });
  for (const [index, reconstructed] of reconstructedInputs.entries()) {
    const captured = modelExchanges[index]?.request;
    assert.ok(captured, `missing captured request ${index}`);
    assert.ok(
      Array.isArray(captured.messages),
      `captured request ${index} must retain its canonical messages`
    );
    const safeCapturedMessages = await sanitizer.sanitize(captured.messages);
    assert.ok(Array.isArray(safeCapturedMessages));
    assert.deepEqual(
      reconstructed.messages.map(toComparableMessage),
      safeCapturedMessages.map(toComparableMessage),
      `rollout generation ${reconstructed.generationId} did not reconstruct the captured message sequence`
    );
    assert.equal(
      reconstructed.messageCount,
      captured.messages.length,
      `rollout generation ${reconstructed.generationId} has an incorrect message count`
    );
    const safeCapturedTools = await sanitizer.sanitize(
      captured.toolProtocol ?? captured.tools.map((name) => ({ name }))
    );
    assert.ok(Array.isArray(safeCapturedTools));
    assert.deepEqual(
      reconstructed.tools,
      JSON.parse(JSON.stringify(safeCapturedTools)) as unknown,
      `rollout generation ${reconstructed.generationId} did not reconstruct the captured tool protocol`
    );
    assert.match(
      reconstructed.stateHash,
      /^[a-f0-9]{64}$/,
      `rollout generation ${reconstructed.generationId} has an invalid state hash`
    );
  }
}

function toComparableMessage(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  const message = value as Record<string, unknown>;
  return {
    role: message.role,
    content: plainJsonValue(message.content),
    ...(message.name !== undefined ? { name: message.name } : {}),
    ...(message.toolCallId !== undefined
      ? { toolCallId: message.toolCallId }
      : {})
  };
}

function plainJsonValue(value: unknown): unknown {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value)) as unknown;
}
