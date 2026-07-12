import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../home/loadConfig";
import { resolveGestaltHome } from "../home/resolveGestaltHome";
import type { ModelExchangeSink, ModelExchangeSnapshot } from "../model/session";
import { createRolloutReader } from "../rollout";
import { createDefaultToolRegistry } from "../tools/registry";
import type { ActionProposal } from "../tools/schemas";
import { createActiveRollout } from "./activeRollout";

const root = await mkdtemp(path.join(os.tmpdir(), "gestalt-active-rollout-"));
try {
  const home = await resolveGestaltHome({ homePath: root });
  const config = await loadConfig(home);
  const now = createClock("2026-07-12T12:00:00.000Z");
  const rollout = createActiveRollout({
    home,
    config,
    rolloutId: "loop-1",
    activeLoopId: "loop-1",
    conversationKey: "group:g1",
    eventId: "event-1",
    tools: createDefaultToolRegistry(),
    startedAt: now().toISOString(),
    now
  });

  const initialMessages = [
    { role: "system", content: "persona" },
    {
      role: "user",
      content:
        "inspect C:\\Users\\siru\\image.png and https://temp.invalid/a?signature=secret"
    }
  ];
  const assistant = { role: "assistant", content: "ack" };
  const firstExchange: ModelExchangeSnapshot = {
    exchangeId: "exchange-1",
    purpose: "agent_action",
    request: {
      provider: "test",
      model: "test-model",
      temperature: 0,
      stepNumber: 0,
      messages: initialMessages,
      tools: ["send_group_message"],
      requestBody: { image: Buffer.from([1, 2, 3]) }
    },
    response: {
      messages: [assistant],
      finishReason: "tool-calls",
      usage: { inputTokens: 10, outputTokens: 2 }
    },
    status: "completed",
    startedAt: now().toISOString(),
    endedAt: now().toISOString()
  };
  await rollout.exchangeSink.onStepStarted(firstExchange);
  const inlineTool: ActionProposal = {
    id: "inline-tool-1",
    proposedAt: now().toISOString(),
    toolName: "fetch_message",
    params: { messageId: "quoted-message-1" }
  };
  await rollout.recordToolStarted(inlineTool, false);
  await rollout.recordToolFinished(
    inlineTool,
    {
      proposal: inlineTool,
      status: "executed",
      executedAt: now().toISOString(),
      result: { ok: true, externalId: "quoted-message-1" }
    },
    false
  );
  await rollout.exchangeSink.onStepCompleted(firstExchange);

  await recordExchange(rollout.exchangeSink, {
    exchangeId: "exchange-2",
    purpose: "agent_action",
    request: {
      provider: "test",
      model: "test-model",
      temperature: 0,
      stepNumber: 1,
      messages: [
        ...initialMessages,
        assistant,
        { role: "user", content: "steer" }
      ],
      tools: ["send_group_message"]
    },
    status: "cancelled",
    startedAt: now().toISOString(),
    endedAt: now().toISOString()
  });

  await recordExchange(rollout.exchangeSink, {
    exchangeId: "exchange-3",
    purpose: "agent_action",
    request: {
      provider: "test",
      model: "test-model",
      temperature: 0,
      stepNumber: 2,
      messages: [
        ...initialMessages,
        assistant,
        { role: "user", content: "steer" },
        { role: "user", content: "retry" }
      ],
      tools: ["send_group_message"]
    },
    response: {
      messages: [{ role: "assistant", content: "committed-after-retry" }],
      finishReason: "stop"
    },
    status: "completed",
    startedAt: now().toISOString(),
    endedAt: now().toISOString()
  });

  const proposal: ActionProposal = {
    id: "action-1",
    proposedAt: now().toISOString(),
    toolName: "send_group_message",
    params: { groupId: "g1", text: "hello" }
  };
  await rollout.recordToolStarted(proposal, true);
  await rollout.recordToolFinished(
    proposal,
    {
      proposal,
      status: "executed",
      executedAt: now().toISOString(),
      result: { ok: true, externalId: "external-1" }
    },
    true
  );
  const unknownProposal: ActionProposal = {
    id: "action-unknown",
    proposedAt: now().toISOString(),
    toolName: "send_group_message",
    params: { groupId: "g1", text: "possibly sent" }
  };
  await rollout.recordToolStarted(unknownProposal, true);
  await rollout.recordToolFinished(
    unknownProposal,
    {
      proposal: unknownProposal,
      status: "result_unknown",
      executedAt: now().toISOString(),
      reason: "response lost after dispatch"
    },
    true
  );
  await rollout.recordSpans([
    {
      id: "span-1",
      traceId: "trace-1",
      name: "model.decide",
      startedAt: now().toISOString(),
      endedAt: now().toISOString(),
      attributes: {}
    }
  ]);
  await rollout.close("completed");

  const reader = createRolloutReader({ tracesDir: home.tracesDir });
  const detail = await reader.read("loop-1");
  assert.equal(detail.summary.status, "completed");
  assert.equal(detail.summary.generationCount, 3);
  const initializedIndex = detail.records.findIndex(
    (record) => record.type === "model_session_initialized"
  );
  const initialUserIndex = detail.records.findIndex(
    (record) =>
      record.type === "message_committed" && record.source === "user"
  );
  const inlineToolIndex = detail.records.findIndex(
    (record) =>
      record.type === "tool_completed" &&
      record.toolCallId === inlineTool.id
  );
  const firstGenerationIndex = detail.records.findIndex(
    (record) => record.type === "generation_completed"
  );
  assert.ok(initializedIndex > 0);
  assert.ok(initialUserIndex > initializedIndex);
  assert.ok(inlineToolIndex > initialUserIndex);
  assert.ok(firstGenerationIndex > inlineToolIndex);
  assert.equal(detail.summary.outboundActionCount, 2);
  assert.deepEqual(detail.unresolvedOutboundActions, [
    {
      actionId: "action-unknown",
      toolName: "send_group_message",
      startedAt: detail.records.find(
        (record) =>
          record.type === "outbound_action_started" &&
          record.actionId === "action-unknown"
      )?.timestamp,
      status: "failed",
      reason: "result_unknown_after_dispatch"
    }
  ]);
  assert.equal(
    detail.records.some(
      (record) =>
        record.type === "outbound_action_finished" &&
        record.actionId === "action-unknown"
    ),
    false
  );
  const generations = detail.records.filter(
    (record) => record.type === "generation_completed"
  );
  assert.equal(generations[1]?.status, "cancelled");
  assert.deepEqual(generations[1]?.outputMessageIds, []);
  assert.equal(generations[1]?.finishReason, undefined);
  assert.equal(generations[1]?.usage, undefined);
  assert.equal(
    detail.records.some(
      (record) =>
        record.type === "message_committed" &&
        JSON.stringify(record.message).includes("must-not-commit")
    ),
    false
  );
  const cancelledIndex = detail.records.indexOf(generations[1]!);
  const nextGenerationIndex = detail.records.indexOf(generations[2]!);
  assert.equal(
    detail.records
      .slice(cancelledIndex + 1, nextGenerationIndex)
      .some(
        (record) =>
          record.type === "message_committed" &&
          (record.source === "assistant" || record.source === "tool")
      ),
    false,
    "a cancelled generation must not commit assistant or tool output"
  );
  const firstCommitAfterCancellation = detail.records
    .slice(cancelledIndex + 1)
    .find((record) => record.type === "message_committed");
  assert.equal(firstCommitAfterCancellation?.type, "message_committed");
  assert.equal(firstCommitAfterCancellation?.source, "steer");
  assert.equal(
    firstCommitAfterCancellation?.previousStateHash,
    generations[1]?.inputStateHash,
    "a cancelled generation must not advance canonical state"
  );
  assert.equal(firstCommitAfterCancellation?.message.content, "retry");
  const reconstructed = await reader.reconstructInput(
    "loop-1",
    generations[1]!.generationId
  );
  assert.equal(reconstructed.messages.at(-1)?.content, "steer");

  const jsonl = await readFile(
    (await reader.read("loop-1")).summary.id === "loop-1"
      ? findRolloutPath(detail.records[0]!.timestamp, home.tracesDir)
      : "",
    "utf8"
  );
  assert.equal(jsonl.includes("1,2,3"), false);
  assert.equal(jsonl.includes("C:\\\\Users"), false);
  assert.equal(jsonl.includes("signature=secret"), false);
} finally {
  await rm(root, { recursive: true, force: true });
}

function createClock(initial: string): () => Date {
  let time = Date.parse(initial);
  return () => new Date(time++);
}

async function recordExchange(
  sink: ModelExchangeSink,
  exchange: ModelExchangeSnapshot
): Promise<void> {
  await sink.onStepStarted(exchange);
  await sink.onStepCompleted(exchange);
}

function findRolloutPath(timestamp: string, tracesDir: string): string {
  const day = timestamp.slice(0, 10).split("-");
  return path.join(
    tracesDir,
    day[0]!,
    day[1]!,
    day[2]!,
    "rollout-20260712T120000.000Z-loop-1.jsonl"
  );
}
