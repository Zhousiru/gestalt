import { randomUUID } from "node:crypto";
import type { Conversation } from "../events/schemas";
import {
  getConversationKey,
  type CreatedMessageWindow,
  type SessionStore
} from "../session/store";
import {
  MessageWindowSchema,
  type MessageWindow,
  type SessionEventRecord,
  type SessionTurnRecord,
  type TurnPhase
} from "../session/schemas";
import {
  type AgentLoopDependencies as BaseAgentLoopDependencies,
  type AgentTurnResult,
  recordAgentTurnTrace,
  runDreamingForAgentTurn,
  runAgentTurn
} from "./agentLoop";
import {
  evaluateAgentLoopExitTriggers,
  getNextAgentLoopIdleTimeoutMs,
  type AgentLoopExitDecision,
  type AgentLoopExitTrigger,
  type AgentLoopExitCause,
  type AgentLoopExitState
} from "./exitTriggers";
import { isTurnSteeredError, TurnSteeredError } from "./turnSignals";

export interface ActiveLoopDependencies extends BaseAgentLoopDependencies {
  sessionStore: SessionStore;
  maxSteersPerTurn: number;
}

type ActiveLoopPhase = TurnPhase | "waiting_for_input";

interface WindowPart {
  window: MessageWindow;
  eventRecords: SessionEventRecord[];
}

interface MergedWindowParts {
  window: MessageWindow;
  eventRecords: SessionEventRecord[];
  windowIds: string[];
}

export interface ActiveLoop {
  id: string;
  conversation: Conversation;
  conversationKey: string;
  phase: ActiveLoopPhase;
  loopStartedAt: string;
  currentTurnId: string;
  currentTurnStartedAt: string;
  parts: WindowPart[];
  pendingParts: WindowPart[];
  restartCount: number;
  turnIds: string[];
  results: AgentTurnResult[];
  consecutiveSayNothing: number;
  lastResult?: AgentTurnResult;
  abortController?: AbortController;
  idleExitTimer?: ReturnType<typeof setTimeout>;
  wakeForInput?: () => void;
  promise: Promise<AgentTurnResult>;
}

export function startActiveLoopWindow(
  dependencies: ActiveLoopDependencies,
  activeLoops: Map<string, ActiveLoop>,
  exitTriggers: AgentLoopExitTrigger[],
  part: CreatedMessageWindow,
  onSettled?: (conversationKey: string) => void
): Promise<AgentTurnResult> {
  const conversationKey = getConversationKey(part.window.conversation);
  const activeLoop = activeLoops.get(conversationKey);

  if (activeLoop) {
    activeLoop.pendingParts.push(part);
    if (activeLoop.phase === "waiting_for_input") {
      activeLoop.wakeForInput?.();
    } else if (isCancellablePhase(activeLoop.phase)) {
      activeLoop.abortController?.abort(new TurnSteeredError());
    }
    return activeLoop.promise;
  }

  const startedAt = dependencies.now().toISOString();
  const active: ActiveLoop = {
    id: randomUUID(),
    conversation: part.window.conversation,
    conversationKey,
    phase: "queued",
    loopStartedAt: startedAt,
    currentTurnId: randomUUID(),
    currentTurnStartedAt: startedAt,
    parts: [part],
    pendingParts: [],
    restartCount: 0,
    turnIds: [],
    results: [],
    consecutiveSayNothing: 0,
    promise: Promise.resolve(undefined as never)
  };

  activeLoops.set(conversationKey, active);
  active.promise = runActiveLoop(dependencies, exitTriggers, active).finally(
    () => {
      activeLoops.delete(conversationKey);
      clearActiveLoopIdleExit(active);
      onSettled?.(conversationKey);
    }
  );

  return active.promise;
}

export function canInjectIntoActiveLoop(
  activeLoop: ActiveLoop,
  maxSteersPerTurn: number
): boolean {
  if (activeLoop.phase === "waiting_for_input") {
    return true;
  }
  return (
    isCancellablePhase(activeLoop.phase) &&
    activeLoop.restartCount < maxSteersPerTurn
  );
}

export function clearActiveLoopIdleExit(activeLoop: ActiveLoop): void {
  if (activeLoop.idleExitTimer) {
    clearTimeout(activeLoop.idleExitTimer);
    delete activeLoop.idleExitTimer;
  }
}

async function runActiveLoop(
  dependencies: ActiveLoopDependencies,
  exitTriggers: AgentLoopExitTrigger[],
  active: ActiveLoop
): Promise<AgentTurnResult> {
  while (true) {
    prepareNextTurn(active, dependencies.now);
    const result = await runSteerableTurn(dependencies, active);
    active.results.push(result);
    updateActiveLoopAfterTurn(active, result);
    recordSelfMessagesFromToolResults(dependencies, result);

    const afterTurnDecision = evaluateExitTriggers(
      dependencies,
      exitTriggers,
      active,
      {
        type: "after_turn",
        result
      }
    );
    if (afterTurnDecision) {
      recordLoopExit(dependencies, active, afterTurnDecision);
      await runLoopDreaming(dependencies, active, result);
      await recordAgentTurnTrace(dependencies, result);
      return result;
    }

    const idleDecision = await waitForNextInputOrExit(
      dependencies,
      exitTriggers,
      active
    );
    if (idleDecision) {
      recordLoopExit(dependencies, active, idleDecision);
      await runLoopDreaming(dependencies, active, result);
      await recordAgentTurnTrace(dependencies, result);
      return result;
    }

    await recordAgentTurnTrace(dependencies, result);
    active.parts = active.pendingParts;
    active.pendingParts = [];
    active.restartCount = 0;
  }
}

async function runLoopDreaming(
  dependencies: ActiveLoopDependencies,
  active: ActiveLoop,
  result: AgentTurnResult
): Promise<void> {
  const input = createLoopDreamingInput(dependencies, active);
  if (!input) {
    return;
  }

  await runDreamingForAgentTurn(dependencies, result, input);
}

function createLoopDreamingInput(
  dependencies: ActiveLoopDependencies,
  active: ActiveLoop
):
  | {
      window: MessageWindow;
      eventRecords: SessionEventRecord[];
      proposedActions: AgentTurnResult["proposedActions"];
      toolResults: AgentTurnResult["toolResults"];
    }
  | undefined {
  const firstResult = active.results[0];
  const lastResult = active.results.at(-1);
  if (!firstResult || !lastResult) {
    return undefined;
  }

  const fromSeq = Math.min(
    ...active.results.map((candidate) => candidate.window.fromSeq)
  );
  const sessionEvents = dependencies.sessionStore
    .getEvents(active.conversation)
    .filter((record) => record.seq >= fromSeq);
  const firstRecord = sessionEvents[0];
  const lastRecord = sessionEvents.at(-1);
  if (!firstRecord || !lastRecord) {
    return undefined;
  }

  const window = MessageWindowSchema.parse({
    id: `dream-${active.id}-${firstRecord.seq}-${lastRecord.seq}`,
    conversation: active.conversation,
    reason: "replay",
    fromSeq: firstRecord.seq,
    toSeq: lastRecord.seq,
    eventSeqs: sessionEvents.map((record) => record.seq),
    closedAt: dependencies.now().toISOString()
  });

  return {
    window,
    eventRecords: sessionEvents,
    proposedActions: active.results.flatMap(
      (candidate) => candidate.proposedActions
    ),
    toolResults: active.results.flatMap((candidate) => candidate.toolResults)
  };
}

async function runSteerableTurn(
  dependencies: ActiveLoopDependencies,
  active: ActiveLoop
): Promise<AgentTurnResult> {
  while (true) {
    const abortController = new AbortController();
    active.abortController = abortController;
    const merged = mergeWindowParts(active, dependencies.now);

    try {
      const result = await runAgentTurn(dependencies, {
        window: merged.window,
        eventRecords: merged.eventRecords,
        steerCount: active.restartCount,
        includeSelfHistory: active.turnIds.length === 0,
        signal: abortController.signal,
        onPhaseChange(phase) {
          active.phase = phase;
        }
      });

      dependencies.sessionStore.recordTurn(
        createSessionTurnRecord(active, result, merged, dependencies.now)
      );
      active.turnIds.push(active.currentTurnId);
      return result;
    } catch (error) {
      if (
        isTurnSteeredError(error) &&
        active.pendingParts.length > 0 &&
        active.restartCount < dependencies.maxSteersPerTurn
      ) {
        active.phase = "steering";
        active.parts.push(...active.pendingParts);
        active.pendingParts = [];
        active.restartCount += 1;
        continue;
      }
      throw error;
    }
  }
}

function mergeWindowParts(
  active: ActiveLoop,
  now: () => Date
): MergedWindowParts {
  const firstPart = active.parts[0];
  if (!firstPart) {
    throw new Error("Cannot run an agent turn without a message window.");
  }

  const recordsBySeq = new Map<number, SessionEventRecord>();
  for (const part of active.parts) {
    for (const record of part.eventRecords) {
      recordsBySeq.set(record.seq, record);
    }
  }

  const eventRecords = Array.from(recordsBySeq.values()).sort(
    (left, right) => left.seq - right.seq
  );
  const firstRecord = eventRecords[0];
  const lastRecord = eventRecords.at(-1);
  if (!firstRecord || !lastRecord) {
    throw new Error("Cannot run an agent turn without session events.");
  }

  const window = MessageWindowSchema.parse({
    id: `turn-${active.id}-${firstRecord.seq}-${lastRecord.seq}`,
    conversation: firstPart.window.conversation,
    reason: active.parts.length > 1 ? "steer" : firstPart.window.reason,
    fromSeq: firstRecord.seq,
    toSeq: lastRecord.seq,
    eventSeqs: eventRecords.map((record) => record.seq),
    closedAt: now().toISOString()
  });

  return {
    window,
    eventRecords,
    windowIds: active.parts.map((part) => part.window.id)
  };
}

function createSessionTurnRecord(
  active: ActiveLoop,
  result: AgentTurnResult,
  merged: MergedWindowParts,
  now: () => Date
): SessionTurnRecord {
  return {
    id: active.currentTurnId,
    traceId: result.traceId,
    conversation: result.window.conversation,
    status: "completed",
    startedAt: active.currentTurnStartedAt,
    endedAt: now().toISOString(),
    windowIds: merged.windowIds,
    fromSeq: result.window.fromSeq,
    toSeq: result.window.toSeq,
    eventSeqs: result.window.eventSeqs,
    steerCount: result.steerCount,
    phases: result.phases,
    proposedActions: result.proposedActions,
    toolResults: result.toolResults
  };
}

function prepareNextTurn(active: ActiveLoop, now: () => Date): void {
  const startedAt = now().toISOString();
  active.currentTurnId = randomUUID();
  active.currentTurnStartedAt = startedAt;
  delete active.abortController;
  active.phase = "queued";
}

function updateActiveLoopAfterTurn(
  active: ActiveLoop,
  result: AgentTurnResult
): void {
  active.lastResult = result;
  if (result.proposedActions.every((action) => action.toolName === "say_nothing")) {
    active.consecutiveSayNothing += 1;
    return;
  }
  active.consecutiveSayNothing = 0;
}

function recordSelfMessagesFromToolResults(
  dependencies: ActiveLoopDependencies,
  result: AgentTurnResult
): void {
  for (const toolResult of result.toolResults) {
    const proposal = toolResult.proposal;
    if (
      toolResult.status !== "executed" ||
      proposal.toolName !== "send_group_message" ||
      result.window.conversation.kind !== "group" ||
      proposal.params.groupId !== result.window.conversation.id
    ) {
      continue;
    }

    const selfId = readOptionalString(
      dependencies.config.flatValues,
      "bot_user_id"
    ) ?? result.event.source.accountId ?? "gestalt-bot";
    const selfName =
      readOptionalString(dependencies.config.flatValues, "bot_display_name") ??
      "Gestalt";
    const text = proposal.params.text;
    const replyToMessageId = parseLeadingReplyMessageId(text);
    const occurredAt = toolResult.executedAt;

    dependencies.sessionStore.appendEvent(
      {
        id: `self-event-${proposal.id}`,
        type: "MessageReceived",
        occurredAt,
        source: {
          platform: result.event.source.platform,
          connector: "runtime-self",
          accountId: selfId,
          rawEventId: toolResult.result?.externalId ?? proposal.id
        },
        conversation: result.window.conversation,
        sender: {
          id: selfId,
          displayName: selfName,
          isSelf: true
        },
        message: {
          id: toolResult.result?.externalId ?? `self-message-${proposal.id}`,
          text,
          rawText: text,
          mentionsBot: false,
          ...(replyToMessageId ? { replyToMessageId } : {})
        },
        raw: {
          generatedBy: "send_group_message",
          proposalId: proposal.id
        }
      },
      {
        receivedAt: occurredAt
      }
    );
  }
}

async function waitForNextInputOrExit(
  dependencies: ActiveLoopDependencies,
  exitTriggers: AgentLoopExitTrigger[],
  active: ActiveLoop
): Promise<AgentLoopExitDecision | undefined> {
  if (active.pendingParts.length > 0) {
    return undefined;
  }

  active.phase = "waiting_for_input";
  const idleTimeoutMs = getNextAgentLoopIdleTimeoutMs(exitTriggers, {
    config: dependencies.config,
    state: createExitState(active),
    now: dependencies.now
  });

  return new Promise((resolve) => {
    let settled = false;

    function cleanup(): void {
      if (settled) {
        return;
      }
      settled = true;
      clearActiveLoopIdleExit(active);
      delete active.wakeForInput;
    }

    active.wakeForInput = () => {
      cleanup();
      resolve(undefined);
    };

    if (idleTimeoutMs !== undefined) {
      active.idleExitTimer = setTimeout(() => {
        const decision = evaluateExitTriggers(
          dependencies,
          exitTriggers,
          active,
          {
            type: "idle_timeout",
            idleMs: idleTimeoutMs,
            ...(active.lastResult ? { lastResult: active.lastResult } : {})
          }
        );
        cleanup();
        resolve(decision);
      }, idleTimeoutMs);
    }
  });
}

function evaluateExitTriggers(
  dependencies: ActiveLoopDependencies,
  exitTriggers: AgentLoopExitTrigger[],
  active: ActiveLoop,
  cause: AgentLoopExitCause
): AgentLoopExitDecision | undefined {
  return evaluateAgentLoopExitTriggers(exitTriggers, {
    config: dependencies.config,
    state: createExitState(active),
    cause,
    now: dependencies.now
  });
}

function createExitState(active: ActiveLoop): AgentLoopExitState {
  return {
    loopId: active.id,
    conversation: active.conversation,
    startedAt: active.loopStartedAt,
    turnIds: active.turnIds,
    turnsCompleted: active.turnIds.length,
    consecutiveSayNothing: active.consecutiveSayNothing
  };
}

function recordLoopExit(
  dependencies: ActiveLoopDependencies,
  active: ActiveLoop,
  decision: AgentLoopExitDecision
): void {
  const lastSeq = active.lastResult?.window.toSeq;
  dependencies.sessionStore.recordLoopExit({
    id: randomUUID(),
    conversation: active.conversation,
    triggerName: decision.triggerName,
    reason: decision.reason,
    ...(decision.description ? { description: decision.description } : {}),
    startedAt: active.loopStartedAt,
    endedAt: dependencies.now().toISOString(),
    turnIds: active.turnIds,
    ...(lastSeq ? { lastSeq } : {})
  });
}

function isCancellablePhase(phase: ActiveLoopPhase): boolean {
  return (
    phase === "queued" ||
    phase === "memory_injecting" ||
    phase === "context_compiling" ||
    phase === "model_running" ||
    phase === "steering"
  );
}

function parseLeadingReplyMessageId(text: string): string | undefined {
  return text.match(/^\[CQ:reply,id=([^\],]+)[^\]]*\]/)?.[1];
}

function readOptionalString(
  flat: ActiveLoopDependencies["config"]["flatValues"],
  key: string
): string | undefined {
  const value = flat[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`Config value ${key} must be a string.`);
  }
  return value;
}
