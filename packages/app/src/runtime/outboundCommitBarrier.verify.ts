import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMockConnector } from "../connectors/mock/connector";
import type { CompiledContext } from "../context/compileContext";
import type {
  CreateModelSessionOptions,
  ModelActionResult,
  ModelClient,
  ModelRunOptions,
  ModelSession
} from "../model/session";
import type { ToolExecutionResult } from "../tools/executeActions";
import type { ActionProposal } from "../tools/schemas";
import type { GroupTrigger } from "../triggers/types";
import { createRuntime } from "./createRuntime";

const NOW = new Date("2026-07-13T09:00:00.000Z");
const GROUP_ID = "commit-barrier-group";
const home = await mkdtemp(
  path.join(os.tmpdir(), "gestalt-outbound-commit-barrier-")
);

try {
  await writeFile(
    path.join(home, "config.toml"),
    [
      "dreaming_enabled = false",
      "agent_loop_aggregation_delay_ms = 1",
      "agent_loop_aggregation_max_delay_ms = 1",
      "agent_loop_aggregation_backoff_multiplier = 1",
      "agent_loop_exit_idle_ms = 60000"
    ].join("\n"),
    "utf8"
  );

  const connector = createMockConnector({ now: () => NOW });
  const barrier = createBarrierModel();
  const trigger: GroupTrigger = {
    name: "verify-outbound-commit-barrier",
    evaluate({ record }) {
      return {
        triggerName: "verify-outbound-commit-barrier",
        reason: "mention",
        conversation: record.event.conversation,
        eventIds: [record.event.id]
      };
    }
  };
  const runtime = await createRuntime({
    gestaltHome: home,
    connector,
    model: barrier.model,
    triggers: [trigger],
    now: () => NOW
  });
  const firstEvent = connector.createMessageEvent({
    conversationId: GROUP_ID,
    messageId: "barrier-first",
    text: "gestalt send exactly once",
    mentionsBot: true
  });
  const firstDispatch = await runtime.dispatchEvent(firstEvent);

  await barrier.effectStepPersisted.promise;
  assert.equal(
    connector.calls.filter((call) => call.kind === "send_group_message").length,
    1,
    "the external effect must be dispatched exactly once before the step commits"
  );
  const durableMessages = await runtime.sessionHistory.recentMessages(
    firstEvent.conversation,
    new Date(NOW.valueOf() - 60_000),
    20
  );
  assert.ok(
    durableMessages.some(
      (record) =>
        record.event.sender.isSelf === true &&
        record.event.message.text === "sent exactly once"
    ),
    "the successful outbound message must already be durable in the session journal"
  );

  const secondEvent = connector.createMessageEvent({
    conversationId: GROUP_ID,
    messageId: "barrier-second",
    text: "new input while the effect is committing",
    mentionsBot: false
  });
  const secondDispatch = await runtime.dispatchEvent(secondEvent);
  assert.equal(secondDispatch.outcome, firstDispatch.outcome);
  await waitFor(() => {
    const state = runtime.sessionStore.getConversationState(
      secondEvent.conversation
    );
    return (
      state?.windows.some((window) =>
        window.eventIds.includes(secondEvent.id)
      ) ?? false
    );
  });
  assert.equal(
    barrier.steerCount,
    0,
    "pending input must not cancel an outbound effect before its model step commits"
  );
  assert.equal(barrier.runReturned, false);

  barrier.allowStepCommit.resolve();
  const steeredContext = await barrier.steeredContext.promise;
  assert.match(steeredContext.transcript, /new input while the effect is committing/);
  assert.equal(
    barrier.runReturned,
    false,
    "pending context must steer the same model run immediately after step commit"
  );
  assert.equal(barrier.steerCount, 1);
  assert.equal(
    connector.calls.filter((call) => call.kind === "send_group_message").length,
    1,
    "steering after commit must not repeat the already-completed effect"
  );

  barrier.allowSteeredAttempt.resolve();
  const result = await firstDispatch.outcome;
  assert.ok(result);
  assert.equal(result.steerCount, 1);
  assert.ok(result.window.eventIds.includes(firstEvent.id));
  assert.ok(result.window.eventIds.includes(secondEvent.id));
  await runtime.whenIdle();

  const rollouts = await runtime.rolloutReader.list({ limit: 10 });
  assert.equal(rollouts.items.length, 1);
  const rollout = await runtime.rolloutReader.read(rollouts.items[0]!.id);
  assert.equal(
    rollout.records.filter((record) => record.type === "generation_completed")
      .length,
    2,
    "the committed effect step and steered follow-up must be separate generations"
  );
  assert.equal(
    rollout.records.filter(
      (record) =>
        record.type === "generation_completed" && record.status === "cancelled"
    ).length,
    0,
    "a completed effect step must never be rewritten as cancelled"
  );
  assert.equal(
    rollout.records.filter(
      (record) => record.type === "outbound_action_started"
    ).length,
    1
  );
  assert.equal(
    rollout.records.filter(
      (record) => record.type === "outbound_action_finished"
    ).length,
    1
  );
} finally {
  await rm(home, { recursive: true, force: true });
}

function createBarrierModel(): {
  model: ModelClient;
  effectStepPersisted: Deferred<void>;
  allowStepCommit: Deferred<void>;
  steeredContext: Deferred<CompiledContext>;
  allowSteeredAttempt: Deferred<void>;
  readonly steerCount: number;
  readonly runReturned: boolean;
} {
  const effectStepPersisted = deferred<void>();
  const allowStepCommit = deferred<void>();
  const steeredContext = deferred<CompiledContext>();
  const allowSteeredAttempt = deferred<void>();
  let steerCount = 0;
  let runReturned = false;

  const model: ModelClient = {
    name: "commit-barrier-model",
    createSession(sessionOptions = {}) {
      return createSession(sessionOptions);
    }
  };

  function createSession(sessionOptions: CreateModelSessionOptions): ModelSession {
    let initialized = false;
    let running = false;
    let pendingContext: CompiledContext | undefined;

    return {
      get initialized() {
        return initialized;
      },
      get running() {
        return running;
      },

      async run(
        context: CompiledContext,
        options: ModelRunOptions = {}
      ): Promise<ModelActionResult> {
        initialized = true;
        running = true;
        try {
          options.onModelAttemptStart?.();
          const send = sendProposal();
          await options.onToolExecutionStart?.(send);
          const connectorResult = await options.connector!.sendGroupMessage({
            groupId: GROUP_ID,
            text: send.params.text
          });
          const sendResult: ToolExecutionResult = {
            proposal: send,
            status: "executed",
            executedAt: NOW.toISOString(),
            result: connectorResult
          };
          await options.onToolExecutionEnd?.(send, sendResult);

          const firstRequest = [
            { role: "system", content: "commit barrier fixture" },
            { role: "user", content: context.transcript }
          ];
          const firstResponse = [
            {
              role: "assistant",
              content: [
                {
                  type: "tool-call",
                  toolCallId: send.id,
                  toolName: send.toolName,
                  input: send.params
                }
              ]
            },
            {
              role: "tool",
              content: [
                {
                  type: "tool-result",
                  toolCallId: send.id,
                  toolName: send.toolName,
                  output: connectorResult
                }
              ]
            }
          ];
          await sessionOptions.exchangeSink?.onStep({
            purpose: "agent_action",
            request: requestSnapshot(0, firstRequest),
            response: {
              messages: firstResponse,
              stepNumber: 0,
              finishReason: "tool-calls"
            },
            status: "completed",
            startedAt: NOW.toISOString(),
            endedAt: NOW.toISOString()
          });
          effectStepPersisted.resolve();

          await allowStepCommit.promise;
          await options.onModelStepCommitted?.();
          assert.ok(
            pendingContext,
            "step commit must synchronously steer pending context into this run"
          );
          await allowSteeredAttempt.promise;
          options.onModelAttemptStart?.();

          const leave = leaveProposal();
          const leaveResult: ToolExecutionResult = {
            proposal: leave,
            status: "skipped",
            executedAt: NOW.toISOString(),
            reason: "Agent loop exit requested."
          };
          await options.onToolExecutionStart?.(leave);
          await options.onToolExecutionEnd?.(leave, leaveResult);
          const secondRequest = [
            ...firstRequest,
            ...firstResponse,
            { role: "user", content: pendingContext.transcript }
          ];
          const secondResponse = [
            {
              role: "assistant",
              content: [
                {
                  type: "tool-call",
                  toolCallId: leave.id,
                  toolName: leave.toolName,
                  input: leave.params
                }
              ]
            },
            {
              role: "tool",
              content: [
                {
                  type: "tool-result",
                  toolCallId: leave.id,
                  toolName: leave.toolName,
                  output: { status: leaveResult.status, reason: leaveResult.reason }
                }
              ]
            }
          ];
          await sessionOptions.exchangeSink?.onStep({
            purpose: "agent_action",
            request: requestSnapshot(1, secondRequest),
            response: {
              messages: secondResponse,
              stepNumber: 1,
              finishReason: "tool-calls"
            },
            status: "completed",
            startedAt: NOW.toISOString(),
            endedAt: NOW.toISOString()
          });
          await options.onModelStepCommitted?.();

          return {
            proposedActions: [send, leave],
            toolResults: [sendResult, leaveResult]
          };
        } finally {
          running = false;
          runReturned = true;
        }
      },

      steer(context) {
        if (!running) {
          return false;
        }
        pendingContext = context;
        steerCount += 1;
        steeredContext.resolve(context);
        return true;
      }
    };
  }

  return {
    model,
    effectStepPersisted,
    allowStepCommit,
    steeredContext,
    allowSteeredAttempt,
    get steerCount() {
      return steerCount;
    },
    get runReturned() {
      return runReturned;
    }
  };
}

function requestSnapshot(stepNumber: number, messages: unknown[]) {
  return {
    provider: "fixture",
    model: "commit-barrier",
    temperature: 0,
    stepNumber,
    messages,
    tools: ["send_group_message", "leave"]
  };
}

function sendProposal(): Extract<
  ActionProposal,
  { toolName: "send_group_message" }
> {
  return {
    id: "send-once",
    proposedAt: NOW.toISOString(),
    toolName: "send_group_message",
    params: { groupId: GROUP_ID, text: "sent exactly once" }
  };
}

function leaveProposal(): Extract<ActionProposal, { toolName: "leave" }> {
  return {
    id: "leave-after-steer",
    proposedAt: NOW.toISOString(),
    toolName: "leave",
    params: {}
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for the buffered steer window.");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}
