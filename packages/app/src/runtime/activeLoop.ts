import { randomUUID } from "node:crypto";
import type { Conversation } from "../events/schemas";
import type { ModelSession } from "../model/session";
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
  readAgentTurnTraceFromError,
  runDreamingForAgentTurn,
  runAgentTurn,
  compileIncrementalAgentContext
} from "./agentLoop";
import {
  evaluateAgentLoopExitTriggers,
  getNextAgentLoopIdleTimeoutMs,
  type AgentLoopExitDecision,
  type AgentLoopExitTrigger,
  type AgentLoopExitCause,
  type AgentLoopExitState
} from "./exitTriggers";
import {
  AgentLoopForceLeaveError,
  isAgentLoopForceLeaveError,
  isTurnSteeredError,
  TurnSteeredError
} from "./turnSignals";
import {
  createActiveRollout,
  type ActiveRollout
} from "./activeRollout";

export interface ActiveLoopDependencies extends BaseAgentLoopDependencies {
  sessionStore: SessionStore;
  maxSteersPerTurn: number;
}

type ActiveLoopPhase = TurnPhase | "waiting_for_input";
const MAX_ACTIVE_LOOP_HISTORY = 128;

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
  modelSession: ModelSession;
  rollout: ActiveRollout;
  parts: WindowPart[];
  pendingParts: WindowPart[];
  restartCount: number;
  turnIds: string[];
  results: AgentTurnResult[];
  consecutiveSayNothing: number;
  lastResult?: AgentTurnResult;
  forceExit?: AgentLoopExitDecision;
  forceExitLastEventId?: string;
  abortController?: AbortController;
  idleExitTimer?: ReturnType<typeof setTimeout>;
  wakeForInput?: () => void;
  promise: Promise<AgentTurnResult | undefined>;
}

export function startActiveLoopWindow(
  dependencies: ActiveLoopDependencies,
  activeLoops: Map<string, ActiveLoop>,
  exitTriggers: AgentLoopExitTrigger[],
  part: CreatedMessageWindow,
  onSettled?: (conversationKey: string) => void
): Promise<AgentTurnResult | undefined> {
  const conversationKey = getConversationKey(part.window.conversation);
  const activeLoop = activeLoops.get(conversationKey);

  if (activeLoop) {
    if (activeLoop.phase === "waiting_for_input") {
      activeLoop.pendingParts.push(part);
      activeLoop.wakeForInput?.();
      return activeLoop.promise;
    }

    if (
      (activeLoop.phase === "model_running" ||
        activeLoop.phase === "steering") &&
      activeLoop.restartCount < dependencies.maxSteersPerTurn
    ) {
      const context = compileIncrementalAgentContext(
        dependencies,
        part.window,
        part.eventRecords
      );
      if (activeLoop.modelSession.steer(context)) {
        activeLoop.parts.push(part);
        activeLoop.restartCount += 1;
        activeLoop.phase = "steering";
        return activeLoop.promise;
      }
    }

    activeLoop.pendingParts.push(part);
    if (isCancellablePhase(activeLoop.phase)) {
      activeLoop.abortController?.abort(new TurnSteeredError());
    }
    return activeLoop.promise;
  }

  const startedAt = dependencies.now().toISOString();
  const loopId = randomUUID();
  const currentEventId = part.eventRecords.at(-1)?.event.id;
  const rollout = createActiveRollout({
    home: dependencies.home,
    config: dependencies.config,
    rolloutId: loopId,
    activeLoopId: loopId,
    conversationKey,
    ...(currentEventId ? { eventId: currentEventId } : {}),
    tools: dependencies.tools,
    startedAt,
    now: dependencies.now
  });
  const active: ActiveLoop = {
    id: loopId,
    conversation: part.window.conversation,
    conversationKey,
    phase: "queued",
    loopStartedAt: startedAt,
    currentTurnId: randomUUID(),
    currentTurnStartedAt: startedAt,
    modelSession: dependencies.model.createSession({
      exchangeSink: rollout.exchangeSink
    }),
    rollout,
    parts: [part],
    pendingParts: [],
    restartCount: 0,
    turnIds: [],
    results: [],
    consecutiveSayNothing: 0,
    promise: Promise.resolve(undefined)
  };

  dependencies.sessionStore.pinConversation(active.conversation);
  activeLoops.set(conversationKey, active);
  active.promise = runActiveLoop(dependencies, exitTriggers, active)
    .then(
      async (result) => {
        await active.rollout.close("completed");
        dependencies.liveEvents?.publish("rollout.recorded", {
          rolloutId: active.rollout.id,
          conversationKey: active.conversationKey,
          status: "completed"
        });
        return result;
      },
      async (error: unknown) => {
        const trace = readAgentTurnTraceFromError(error);
        if (trace) {
          await active.rollout.recordSpans(trace.spans);
        }
        await active.rollout.close(
          "failed",
          error instanceof Error ? error.message : String(error)
        );
        dependencies.liveEvents?.publish("rollout.recorded", {
          rolloutId: active.rollout.id,
          conversationKey: active.conversationKey,
          status: "failed"
        });
        throw error;
      }
    )
    .finally(() => {
      activeLoops.delete(conversationKey);
      clearActiveLoopIdleExit(active);
      dependencies.sessionStore.unpinConversation(active.conversation);
      onSettled?.(conversationKey);
    });

  return active.promise;
}

export function forceActiveLoopExit(
  activeLoop: ActiveLoop,
  input: {
    decision: AgentLoopExitDecision;
    lastEventId?: string;
  }
): void {
  activeLoop.forceExit = input.decision;
  if (input.lastEventId !== undefined) {
    activeLoop.forceExitLastEventId = input.lastEventId;
  }

  clearActiveLoopIdleExit(activeLoop);
  if (activeLoop.phase === "waiting_for_input") {
    activeLoop.wakeForInput?.();
    return;
  }

  if (activeLoop.phase === "executing") {
    return;
  }

  activeLoop.abortController?.abort(new AgentLoopForceLeaveError());
}

export function canInjectIntoActiveLoop(
  activeLoop: ActiveLoop,
  maxSteersPerTurn: number
): boolean {
  if (
    activeLoop.phase === "waiting_for_input" ||
    activeLoop.phase === "executing" ||
    activeLoop.phase === "completed"
  ) {
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
): Promise<AgentTurnResult | undefined> {
  while (true) {
    if (active.forceExit) {
      await recordLoopExit(dependencies, active, active.forceExit);
      return active.lastResult;
    }

    prepareNextTurn(active, dependencies.now);
    let result: AgentTurnResult;
    try {
      result = await runSteerableTurn(dependencies, active);
    } catch (error) {
      if (isAgentLoopForceLeaveError(error) && active.forceExit) {
        const forceExitTrace = readAgentTurnTraceFromError(error);
        if (forceExitTrace) {
          await active.rollout.recordSpans(forceExitTrace.spans);
        }
        await recordLoopExit(dependencies, active, active.forceExit);
        return active.lastResult;
      }
      throw error;
    }
    appendBounded(active.results, result, MAX_ACTIVE_LOOP_HISTORY);
    await active.rollout.recordSpans(result.trace.spans);
    updateActiveLoopAfterTurn(active, result);

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
      await recordLoopExit(dependencies, active, afterTurnDecision);
      await runLoopDreaming(dependencies, active, result);
      await active.rollout.recordSpans(result.trace.spans);
      return result;
    }

    const idleDecision = await waitForNextInputOrExit(
      dependencies,
      exitTriggers,
      active
    );
    if (idleDecision) {
      await recordLoopExit(dependencies, active, idleDecision);
      await runLoopDreaming(dependencies, active, result);
      await active.rollout.recordSpans(result.trace.spans);
      return result;
    }

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

  const modelContinuation = active.modelSession.continuation?.();
  await runDreamingForAgentTurn(dependencies, result, {
    ...input,
    ...(modelContinuation ? { modelContinuation } : {})
  });
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

  const firstEventId = firstResult.window.eventIds[0];
  if (!firstEventId) {
    return undefined;
  }
  const conversationEvents = dependencies.sessionStore.getEvents(
    active.conversation
  );
  const firstEventIndex = conversationEvents.findIndex(
    (record) => record.event.id === firstEventId
  );
  const sessionEvents =
    firstEventIndex >= 0 ? conversationEvents.slice(firstEventIndex) : [];
  const firstRecord = sessionEvents[0];
  const lastRecord = sessionEvents.at(-1);
  if (!firstRecord || !lastRecord) {
    return undefined;
  }

  const window = MessageWindowSchema.parse({
    id: `dream-${active.id}-${firstRecord.event.id}-${lastRecord.event.id}`,
    conversation: active.conversation,
    reason: "replay",
    eventIds: sessionEvents.map((record) => record.event.id),
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
        modelSession: active.modelSession,
        rollout: active.rollout,
        includeSelfHistory: true,
        signal: abortController.signal,
        onPhaseChange(phase) {
          const previousPhase = active.phase;
          active.phase = phase;
          if (previousPhase === "executing" && phase === "model_running") {
            steerPendingPartsAfterCommittedStep(dependencies, active);
          }
        }
      });

      const completed = mergeWindowParts(active, dependencies.now);
      result.window = completed.window;
      result.eventRecords = completed.eventRecords;
      result.event = completed.eventRecords.at(-1)?.event ?? result.event;
      result.steerCount = active.restartCount;

      await dependencies.sessionStore.recordTurn(
        createSessionTurnRecord(active, result, completed, dependencies.now)
      );
      appendBounded(
        active.turnIds,
        active.currentTurnId,
        MAX_ACTIVE_LOOP_HISTORY
      );
      return result;
    } catch (error) {
      if (
        isTurnSteeredError(error) &&
        active.pendingParts.length > 0 &&
        active.restartCount < dependencies.maxSteersPerTurn
      ) {
        const steeredTrace = readAgentTurnTraceFromError(error);
        if (steeredTrace) {
          await active.rollout.recordSpans(steeredTrace.spans);
        }
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

function steerPendingPartsAfterCommittedStep(
  dependencies: ActiveLoopDependencies,
  active: ActiveLoop
): void {
  if (
    active.pendingParts.length === 0 ||
    active.restartCount >= dependencies.maxSteersPerTurn
  ) {
    return;
  }

  const pending = mergeParts(active, active.pendingParts, dependencies.now);
  const context = compileIncrementalAgentContext(
    dependencies,
    pending.window,
    pending.eventRecords
  );
  if (!active.modelSession.steer(context)) {
    return;
  }

  active.parts.push(...active.pendingParts);
  active.pendingParts = [];
  active.restartCount += 1;
  active.phase = "steering";
}

function mergeWindowParts(
  active: ActiveLoop,
  now: () => Date
): MergedWindowParts {
  return mergeParts(active, active.parts, now);
}

function mergeParts(
  active: ActiveLoop,
  parts: readonly WindowPart[],
  now: () => Date
): MergedWindowParts {
  const firstPart = parts[0];
  if (!firstPart) {
    throw new Error("Cannot run an agent turn without a message window.");
  }

  const recordsById = new Map<string, SessionEventRecord>();
  for (const part of parts) {
    for (const record of part.eventRecords) {
      if (!recordsById.has(record.event.id)) {
        recordsById.set(record.event.id, record);
      }
    }
  }

  const eventRecords = Array.from(recordsById.values());
  const firstRecord = eventRecords[0];
  const lastRecord = eventRecords.at(-1);
  if (!firstRecord || !lastRecord) {
    throw new Error("Cannot run an agent turn without session events.");
  }

  const window = MessageWindowSchema.parse({
    id: `turn-${active.id}-${firstRecord.event.id}-${lastRecord.event.id}`,
    conversation: firstPart.window.conversation,
    reason: parts.length > 1 ? "steer" : firstPart.window.reason,
    eventIds: eventRecords.map((record) => record.event.id),
    closedAt: now().toISOString()
  });

  return {
    window,
    eventRecords,
    windowIds: parts.map((part) => part.window.id)
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
    rolloutId: active.rollout.id,
    conversation: result.window.conversation,
    status: "completed",
    startedAt: active.currentTurnStartedAt,
    endedAt: now().toISOString(),
    windowIds: merged.windowIds,
    eventIds: result.window.eventIds,
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

async function waitForNextInputOrExit(
  dependencies: ActiveLoopDependencies,
  exitTriggers: AgentLoopExitTrigger[],
  active: ActiveLoop
): Promise<AgentLoopExitDecision | undefined> {
  if (active.forceExit) {
    return active.forceExit;
  }

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
      const forceExit = active.forceExit;
      cleanup();
      resolve(forceExit);
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

async function recordLoopExit(
  dependencies: ActiveLoopDependencies,
  active: ActiveLoop,
  decision: AgentLoopExitDecision
): Promise<void> {
  const lastEventId =
    active.forceExitLastEventId ?? active.lastResult?.window.eventIds.at(-1);
  await dependencies.sessionStore.recordLoopExit({
    id: randomUUID(),
    conversation: active.conversation,
    triggerName: decision.triggerName,
    reason: decision.reason,
    ...(decision.description ? { description: decision.description } : {}),
    startedAt: active.loopStartedAt,
    endedAt: dependencies.now().toISOString(),
    turnIds: active.turnIds,
    ...(lastEventId ? { lastEventId } : {})
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

function appendBounded<T>(values: T[], value: T, limit: number): void {
  values.push(value);
  const excess = values.length - limit;
  if (excess > 0) {
    values.splice(0, excess);
  }
}
