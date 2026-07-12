import { createHash, randomUUID } from "node:crypto";
import { compileContext } from "../context/compileContext";
import { renderConversationTranscript } from "../context/renderTranscript";
import { selectContextEvents } from "../context/selectContextEvents";
import type { ResolvedTimezone } from "../context/time";
import { formatZonedDateTime } from "../context/time";
import type { CanonicalEvent } from "../events/schemas";
import type { Connector } from "../connectors/types";
import type { GestaltConfig } from "../home/loadConfig";
import type { GestaltHome } from "../home/resolveGestaltHome";
import type { DreamingRunResult, DreamingRunner } from "../memory/dreaming";
import type { MemoryStore } from "../memory/store";
import type {
  ModelClient,
  ModelSession,
  ModelSessionContinuation,
  ModelStepTraceSnapshot
} from "../model/session";
import { readModelStepsFromError } from "../model/session";
import type { PersonaPack } from "../persona/loadPersona";
import { sanitizeUntrustedValue } from "../privacy/stickerRedaction";
import type {
  MessageWindow,
  SessionEventRecord,
  TurnPhase,
  TurnPhaseRecord
} from "../session/schemas";
import type { SessionStore } from "../session/store";
import type {
  AgentTurnTrace,
  ObservationRecord,
  SpanRecord
} from "../trace/schemas";
import type { LiveEventSink } from "../live/viewTypes";
import {
  executeActions,
  type ToolExecutionResult,
  type ToolImplementations
} from "../tools/executeActions";
import type { ActionProposal, ToolDefinition } from "../tools/schemas";
import { throwIfTurnSteered } from "./turnSignals";
import type { ActiveRollout } from "./activeRollout";

export interface AgentTurnResult {
  traceId: string;
  event: CanonicalEvent;
  window: MessageWindow;
  eventRecords: SessionEventRecord[];
  steerCount: number;
  phases: TurnPhaseRecord[];
  proposedActions: ActionProposal[];
  toolResults: ToolExecutionResult[];
  dreamingResult?: DreamingRunResult;
  trace: AgentTurnTrace;
}

export interface AgentLoopDependencies {
  home: GestaltHome;
  config: GestaltConfig;
  persona: PersonaPack;
  memoryStore: MemoryStore;
  dreamingRunner: DreamingRunner;
  tools: ToolDefinition[];
  connector: Connector;
  model: ModelClient;
  sessionStore: SessionStore;
  commitOutboundMessage?: (input: {
    sourceEvent: CanonicalEvent;
    proposal: ActionProposal;
    result: ToolExecutionResult;
  }) => Promise<void>;
  toolImplementations?: ToolImplementations;
  liveEvents?: LiveEventSink;
  now: () => Date;
  resolvedTimezone: ResolvedTimezone;
}

export interface RunAgentTurnInput {
  window: MessageWindow;
  eventRecords: SessionEventRecord[];
  steerCount: number;
  modelSession: ModelSession;
  rollout?: ActiveRollout;
  includeSelfHistory?: boolean;
  signal?: AbortSignal;
  onPhaseChange?: (phase: TurnPhase) => void;
}

export interface RunDreamingForAgentTurnInput {
  window: MessageWindow;
  eventRecords: SessionEventRecord[];
  proposedActions: ActionProposal[];
  toolResults: ToolExecutionResult[];
  modelContinuation?: ModelSessionContinuation;
}

export async function runAgentTurn(
  dependencies: AgentLoopDependencies,
  input: RunAgentTurnInput
): Promise<AgentTurnResult> {
  const traceId = input.rollout?.id ?? randomUUID();
  const traceStartedAt = dependencies.now().toISOString();
  const spans: SpanRecord[] = [];
  const observations: ObservationRecord[] = [];
  const phases: TurnPhaseRecord[] = [];
  const event = getCurrentEvent(input.eventRecords);
  let proposedActions: ActionProposal[] = [];
  let toolResults: ToolExecutionResult[] = [];
  const buildTrace = (
    proposedActions: ActionProposal[],
    toolResults: ToolExecutionResult[]
  ): AgentTurnTrace => ({
    id: traceId,
    name: "agent.turn",
    startedAt: traceStartedAt,
    endedAt: dependencies.now().toISOString(),
    gestaltHome: dependencies.home.root,
    eventId: event.id,
    personaVersion: dependencies.persona.version,
    spans,
    observations,
    proposedActions,
    toolResults
  });

  const markPhase = (phase: TurnPhase): void => {
    const record: TurnPhaseRecord = {
      phase,
      at: dependencies.now().toISOString()
    };
    phases.push(record);
    dependencies.liveEvents?.publish(
      "agent.phase.changed",
      {
        traceId,
        phase,
        at: record.at
      },
      record.at
    );
    input.onPhaseChange?.(phase);
  };

  dependencies.liveEvents?.publish(
    "agent.run.started",
    {
      traceId,
      eventId: event.id,
      startedAt: traceStartedAt,
      gestaltHome: dependencies.home.root,
      personaVersion: dependencies.persona.version,
      window: input.window,
      eventRecords: input.eventRecords
    },
    traceStartedAt
  );

  try {
    const context = input.modelSession.initialized
      ? await compileIncrementalTurnContext(
          dependencies,
          input,
          traceId,
          spans,
          observations,
          markPhase
        )
      : await compileInitialTurnContext(
          dependencies,
          input,
          event,
          traceId,
          spans,
          observations,
          markPhase
        );

  markPhase("model_running");
  throwIfTurnSteered(input.signal);
  const modelResult = await runSpan(
    traceId,
    "model.decide",
    spans,
    observations,
    dependencies.now,
    dependencies.liveEvents,
    () =>
      input.modelSession.run(
        context,
        {
          ...(input.signal ? { signal: input.signal } : {}),
          connector: dependencies.connector,
          now: dependencies.now,
          traceId,
          ...(dependencies.toolImplementations
            ? { toolImplementations: dependencies.toolImplementations }
            : {}),
          onModelAttemptStart() {
            input.onPhaseChange?.("model_running");
          },
          onModelStepCommitted() {
            input.onPhaseChange?.("model_running");
          },
          async onToolExecutionStart(proposal) {
            const outbound = isVisibleSideEffect(proposal);
            if (outbound) {
              input.onPhaseChange?.("executing");
            }
            await input.rollout?.recordToolStarted(proposal, outbound);
          },
          async onToolExecutionEnd(proposal, result) {
            const outbound = isVisibleSideEffect(proposal);
            await recordCompletedToolEffect(
              dependencies,
              input.rollout,
              event,
              proposal,
              result,
              outbound
            );
          }
        }
      ),
    { model: dependencies.model.name ?? "unknown" },
    (result) => ({
      modelResponses: summarizeModelResponsesForTrace(result.modelResponses),
      ...promptTraceAttributes(result.modelSteps)
    }),
    (result, span) => ({
      observations: createGenerationObservations({
        traceId,
        parentObservationId: span.id,
        purpose: "agent_action",
        steps: result.modelSteps
      })
    }),
    (error, span) => ({
      observations: createGenerationObservations({
        traceId,
        parentObservationId: span.id,
        purpose: "agent_action",
        steps: readModelStepsFromError(error)
      })
    })
  ).catch((error: unknown) => {
    attachAgentTurnTraceToError(error, buildTrace([], []));
    throw error;
  });
  proposedActions = modelResult.proposedActions;

  markPhase("executing");
  throwIfTurnSteered(input.signal);
  toolResults = await runSpan(
    traceId,
    "tool.execute",
    spans,
    observations,
    dependencies.now,
    dependencies.liveEvents,
    () => {
      if (modelResult.toolResults) {
        return modelResult.toolResults;
      }
      return executeActions({
        connector: dependencies.connector,
        proposals: proposedActions,
        now: dependencies.now,
        traceId,
        ...(dependencies.toolImplementations
          ? { toolImplementations: dependencies.toolImplementations }
          : {}),
        ...(input.rollout
          ? {
              onExecutionStart(proposal: ActionProposal) {
                return input.rollout?.recordToolStarted(
                  proposal,
                  isVisibleSideEffect(proposal)
                );
              },
              onExecutionEnd(
                proposal: ActionProposal,
                result: ToolExecutionResult
              ) {
                return recordCompletedToolEffect(
                  dependencies,
                  input.rollout,
                  event,
                  proposal,
                  result,
                  isVisibleSideEffect(proposal)
                );
              }
            }
          : {})
      });
    },
    {
      proposedActions: proposedActions.length,
      executionSource: modelResult.toolResults
        ? "model_tool_loop"
        : "runtime_execute_actions"
    },
    (result) => ({
      toolCalls: result.map((toolResult) => ({
        toolName: toolResult.proposal.toolName,
        status: toolResult.status,
        ...(toolResult.reason ? { reason: toolResult.reason } : {}),
        ...(toolResult.result?.externalId
          ? { externalId: toolResult.result.externalId }
          : {}),
        ...(toolResult.result?.error ? { error: toolResult.result.error } : {}),
        ...(toolResult.result?.data !== undefined
          ? { dataPreview: truncateForTrace(JSON.stringify(toolResult.result.data)) }
          : {})
      }))
    }),
    (result, span) => ({
      observations: result.map((toolResult) =>
        createToolObservation(traceId, span.id, toolResult)
      )
    })
  );
  markPhase("completed");

  const trace = buildTrace(proposedActions, toolResults);
  dependencies.liveEvents?.publish(
    "agent.run.completed",
    {
      traceId,
      endedAt: trace.endedAt,
      proposedActions,
      toolResults: toolResults.map((result) => ({
        toolName: result.proposal.toolName,
        status: result.status,
        ...(result.reason ? { reason: result.reason } : {})
      }))
    },
    trace.endedAt
  );

  return {
    traceId,
    event,
    window: input.window,
    eventRecords: input.eventRecords,
    steerCount: input.steerCount,
    phases,
    proposedActions,
    toolResults,
    trace
  };
  } catch (error) {
    const trace = buildTrace(proposedActions, toolResults);
    const message = error instanceof Error ? error.message : String(error);
    dependencies.liveEvents?.publish(
      "agent.run.failed",
      {
        traceId,
        endedAt: trace.endedAt,
        error: message
      },
      trace.endedAt
    );
    attachAgentTurnTraceToError(error, trace);
    throw error;
  }
}

async function compileInitialTurnContext(
  dependencies: AgentLoopDependencies,
  input: RunAgentTurnInput,
  event: CanonicalEvent,
  traceId: string,
  spans: SpanRecord[],
  observations: ObservationRecord[],
  markPhase: (phase: TurnPhase) => void
) {
  markPhase("memory_injecting");
  throwIfTurnSteered(input.signal);
  const contextEvents = selectContextEvents({
    config: dependencies.config,
    sessionStore: dependencies.sessionStore,
    window: input.window,
    windowEvents: input.eventRecords,
    includeSelfHistory: input.includeSelfHistory ?? true
  });
  const contextEventRecords = contextEvents.map((entry) => entry.record);
  const memories = await runSpan(
    traceId,
    "memory.inject",
    spans,
    observations,
    dependencies.now,
    dependencies.liveEvents,
    () =>
      dependencies.memoryStore.findRelevantMemories({
        event,
        windowEvents: contextEventRecords
      }),
    {
      strategy: "file-indexes",
      windowId: input.window.id,
      firstEventId: input.window.eventIds[0],
      lastEventId: input.window.eventIds.at(-1),
      contextEventCount: contextEvents.length
    },
    (result) => ({
      memoryFragments: result.length,
      memoryFiles: result.map((memory) => ({
        scope: memory.scope,
        ...(memory.userId ? { userId: memory.userId } : {}),
        relativePath: memory.relativePath,
        contentPreview: truncateForTrace(memory.content)
      }))
    })
  );

  markPhase("context_compiling");
  throwIfTurnSteered(input.signal);
  const contextNow = dependencies.now();
  const localTime = formatZonedDateTime(
    contextNow,
    dependencies.resolvedTimezone.timezone
  );
  return runSpan(
    traceId,
    "context.compile",
    spans,
    observations,
    dependencies.now,
    dependencies.liveEvents,
    () =>
      compileContext({
        event,
        window: input.window,
        windowEvents: input.eventRecords,
        contextEvents,
        persona: dependencies.persona,
        memories,
        tools: dependencies.tools,
        config: dependencies.config,
        now: contextNow,
        timezone: dependencies.resolvedTimezone.timezone
      }),
    {
      mode: "session_initial",
      personaVersion: dependencies.persona.version,
      personaFragments: dependencies.persona.fragments.length,
      memoryFragments: memories.length,
      tools: dependencies.tools.map((tool) => tool.name),
      windowReason: input.window.reason,
      windowEventCount: input.eventRecords.length,
      contextEventCount: contextEvents.length,
      steerCount: input.steerCount,
      timezone: dependencies.resolvedTimezone.timezone,
      timezoneSource: dependencies.resolvedTimezone.source,
      localTime: `${localTime.date} ${localTime.time}`
    }
  );
}

async function compileIncrementalTurnContext(
  dependencies: AgentLoopDependencies,
  input: RunAgentTurnInput,
  traceId: string,
  spans: SpanRecord[],
  observations: ObservationRecord[],
  markPhase: (phase: TurnPhase) => void
) {
  markPhase("context_compiling");
  throwIfTurnSteered(input.signal);
  const contextNow = dependencies.now();
  const localTime = formatZonedDateTime(
    contextNow,
    dependencies.resolvedTimezone.timezone
  );
  return runSpan(
    traceId,
    "context.compile",
    spans,
    observations,
    dependencies.now,
    dependencies.liveEvents,
    () =>
      compileIncrementalAgentContext(
        dependencies,
        input.window,
        input.eventRecords,
        contextNow
      ),
    {
      mode: "session_append",
      windowReason: input.window.reason,
      windowEventCount: input.eventRecords.length,
      steerCount: input.steerCount,
      timezone: dependencies.resolvedTimezone.timezone,
      timezoneSource: dependencies.resolvedTimezone.source,
      localTime: `${localTime.date} ${localTime.time}`
    }
  );
}

export function compileIncrementalAgentContext(
  dependencies: AgentLoopDependencies,
  window: MessageWindow,
  eventRecords: SessionEventRecord[],
  contextNow: Date = dependencies.now()
) {
  const event = getCurrentEvent(eventRecords);
  const contextEvents = selectContextEvents({
    config: dependencies.config,
    sessionStore: dependencies.sessionStore,
    window,
    windowEvents: eventRecords,
    includeSelfHistory: true,
    includeRecentHistory: false
  });
  return compileContext({
    event,
    window,
    windowEvents: eventRecords,
    contextEvents,
    persona: dependencies.persona,
    memories: [],
    tools: dependencies.tools,
    config: dependencies.config,
    now: contextNow,
    timezone: dependencies.resolvedTimezone.timezone
  });
}

function isVisibleSideEffect(proposal: ActionProposal): boolean {
  return (
    proposal.toolName === "send_group_message" ||
    proposal.toolName === "send_dm" ||
    proposal.toolName === "send_image" ||
    proposal.toolName === "send_sticker" ||
    proposal.toolName === "react_to_message" ||
    proposal.toolName === "poke_user" ||
    proposal.toolName === "recall_own_message"
  );
}

async function recordCompletedToolEffect(
  dependencies: AgentLoopDependencies,
  rollout: ActiveRollout | undefined,
  sourceEvent: CanonicalEvent,
  proposal: ActionProposal,
  result: ToolExecutionResult,
  outbound: boolean
): Promise<void> {
  if (outbound && result.status === "executed") {
    try {
      await dependencies.commitOutboundMessage?.({
        sourceEvent,
        proposal,
        result
      });
    } catch (error) {
      dependencies.liveEvents?.publish("session.event.appended", {
        conversationKey: outboundConversationKey(proposal),
        status: "failed",
        summary: `outbound_session_commit_failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      });
    }
  }
  await rollout?.recordToolFinished(proposal, result, outbound);
}

function outboundConversationKey(proposal: ActionProposal): string | undefined {
  if (proposal.toolName === "send_group_message") {
    return `group:${proposal.params.groupId}`;
  }
  if (proposal.toolName === "send_dm") {
    return `private:${proposal.params.userId}`;
  }
  if (
    proposal.toolName === "send_image" ||
    proposal.toolName === "send_sticker"
  ) {
    return `${proposal.params.conversation.kind}:${proposal.params.conversation.id}`;
  }
  return undefined;
}

export async function runDreamingForAgentTurn(
  dependencies: AgentLoopDependencies,
  result: AgentTurnResult,
  input: RunDreamingForAgentTurnInput
): Promise<DreamingRunResult> {
  const event = getCurrentEvent(input.eventRecords);
  const memories = await dependencies.memoryStore.findRelevantMemories({
    event,
    windowEvents: input.eventRecords
  });
  const transcript = renderConversationTranscript({
    event,
    window: input.window,
    windowEvents: input.eventRecords,
    now: dependencies.now(),
    timezone: dependencies.resolvedTimezone.timezone
  });

  const dreamingResult = await runSpan(
    result.traceId,
    "dream.run",
    result.trace.spans,
    result.trace.observations,
    dependencies.now,
    dependencies.liveEvents,
    () =>
      dependencies.dreamingRunner.run({
        home: dependencies.home,
        event,
        window: input.window,
        eventRecords: input.eventRecords,
        transcript,
        memories,
        proposedActions: input.proposedActions,
        toolResults: input.toolResults,
        ...(input.modelContinuation
          ? { modelContinuation: input.modelContinuation }
          : {}),
        now: dependencies.now
      }),
    {
      windowId: input.window.id,
      firstEventId: input.window.eventIds[0],
      lastEventId: input.window.eventIds.at(-1),
      eventCount: input.eventRecords.length,
      proposedActions: input.proposedActions.length,
      toolResults: input.toolResults.length
    },
    (dreamResult) => ({
      dreamingStatus: dreamResult.status,
      commandCount: dreamResult.commands.length,
      commands: dreamResult.commands.map(summarizeDreamingCommand),
      addedFiles: dreamResult.addedFiles,
      changedFiles: dreamResult.changedFiles,
      removedFiles: dreamResult.removedFiles,
      ...promptTraceAttributes(dreamResult.modelSteps),
      ...(dreamResult.error ? { error: dreamResult.error } : {})
    }),
    (dreamResult, span) => ({
      observations: [
        ...createGenerationObservations({
          traceId: result.traceId,
          parentObservationId: span.id,
          purpose: "dreaming",
          steps: dreamResult.modelSteps
        }),
        ...dreamResult.commands.map((command, index) =>
          createDreamingCommandObservation(
            result.traceId,
            span.id,
            command,
            index
          )
        )
      ]
    })
  );
  result.dreamingResult = dreamingResult;
  result.trace.endedAt = dependencies.now().toISOString();
  return dreamingResult;
}

const agentTurnTraceErrorKey = "__gestaltAgentTurnTrace";

export function readAgentTurnTraceFromError(
  error: unknown
): AgentTurnTrace | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const value = (error as { [agentTurnTraceErrorKey]?: unknown })[
    agentTurnTraceErrorKey
  ];
  return value && typeof value === "object"
    ? (value as AgentTurnTrace)
    : undefined;
}

function attachAgentTurnTraceToError(
  error: unknown,
  trace: AgentTurnTrace
): void {
  if (!error || typeof error !== "object") {
    return;
  }
  (error as { [agentTurnTraceErrorKey]?: AgentTurnTrace })[
    agentTurnTraceErrorKey
  ] = trace;
}

function getCurrentEvent(eventRecords: SessionEventRecord[]): CanonicalEvent {
  const record = eventRecords.at(-1);
  if (!record) {
    throw new Error("Agent turn requires at least one session event.");
  }
  return record.event;
}

async function runSpan<T>(
  traceId: string,
  name: string,
  spans: SpanRecord[],
  observations: ObservationRecord[],
  now: () => Date,
  liveEvents: LiveEventSink | undefined,
  operation: () => T | Promise<T>,
  attributes: Record<string, unknown> = {},
  resultAttributes?: (result: T) => Record<string, unknown>,
  resultObservations?: (
    result: T,
    span: SpanRecord
  ) => { observations: ObservationRecord[] },
  errorObservations?: (
    error: unknown,
    span: SpanRecord
  ) => { observations: ObservationRecord[] }
): Promise<T> {
  const spanId = randomUUID();
  const startedAt = now().toISOString();
  liveEvents?.publish(
    "agent.span.started",
    {
      traceId,
      spanId,
      name,
      startedAt,
      attributes
    },
    startedAt
  );
  try {
    const result = await operation();
    const span: SpanRecord = {
      id: spanId,
      traceId,
      name,
      startedAt,
      endedAt: now().toISOString(),
      attributes: {
        ...attributes,
        ...(resultAttributes ? resultAttributes(result) : {}),
        status: "ok"
      }
    };
    const emittedObservations = [
      spanToObservation(span),
      ...(resultObservations?.(result, span).observations ?? [])
    ];
    spans.push(span);
    observations.push(...emittedObservations);
    liveEvents?.publish(
      "agent.span.ended",
      {
        traceId,
        span
      },
      span.endedAt
    );
    for (const observation of emittedObservations) {
      liveEvents?.publish(
        "agent.observation.created",
        {
          traceId,
          observation: summarizeObservationForLive(observation)
        },
        observation.endedAt ?? observation.startedAt ?? span.endedAt
      );
    }
    return result;
  } catch (error) {
    const span: SpanRecord = {
      id: spanId,
      traceId,
      name,
      startedAt,
      endedAt: now().toISOString(),
      attributes: {
        ...attributes,
        status: "error",
        error: error instanceof Error ? error.message : String(error)
      }
    };
    const emittedObservations = [
      spanToObservation(span, "ERROR"),
      ...(errorObservations?.(error, span).observations ?? [])
    ];
    spans.push(span);
    observations.push(...emittedObservations);
    liveEvents?.publish(
      "agent.span.ended",
      {
        traceId,
        span
      },
      span.endedAt
    );
    for (const observation of emittedObservations) {
      liveEvents?.publish(
        "agent.observation.created",
        {
          traceId,
          observation: summarizeObservationForLive(observation)
        },
        observation.endedAt ?? observation.startedAt ?? span.endedAt
      );
    }
    throw error;
  }
}

function summarizeObservationForLive(
  observation: ObservationRecord
): ObservationRecord {
  return {
    id: observation.id,
    traceId: observation.traceId,
    ...(observation.parentObservationId
      ? { parentObservationId: observation.parentObservationId }
      : {}),
    type: observation.type,
    name: observation.name,
    ...(observation.startedAt ? { startedAt: observation.startedAt } : {}),
    ...(observation.endedAt ? { endedAt: observation.endedAt } : {}),
    metadata: summarizeLiveMetadata(observation.metadata),
    ...(observation.model ? { model: observation.model } : {}),
    ...(observation.usage !== undefined ? { usage: observation.usage } : {}),
    ...(observation.level ? { level: observation.level } : {}),
    ...(observation.statusMessage
      ? { statusMessage: truncateForTrace(observation.statusMessage) }
      : {})
  };
}

function summarizeLiveMetadata(
  metadata: Record<string, unknown>
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(metadata).map(([key, value]) => [
      key,
      typeof value === "string" ? truncateForTrace(value) : value
    ])
  );
}

function summarizeDreamingCommand(command: {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
}): Record<string, unknown> {
  return {
    command: command.command,
    exitCode: command.exitCode,
    stdout: truncateForTrace(command.stdout),
    stderr: truncateForTrace(command.stderr)
  };
}

function promptTraceAttributes(
  steps: ModelStepTraceSnapshot[] | undefined
): Record<string, unknown> {
  const prompt = steps
    ?.map((step) => step.request?.prompt)
    .find((candidate) => candidate !== undefined);
  return prompt
    ? {
        promptId: prompt.id,
        promptContentHash: prompt.contentHash,
        ...(prompt.toolPromptHash
          ? { toolPromptHash: prompt.toolPromptHash }
          : {})
      }
    : {};
}

function createGenerationObservations(input: {
  traceId: string;
  parentObservationId: string;
  purpose: "agent_action" | "dreaming";
  steps: ModelStepTraceSnapshot[] | undefined;
}): ObservationRecord[] {
  return (input.steps ?? []).map((step, index) => ({
    id: randomUUID(),
    traceId: input.traceId,
    parentObservationId: input.parentObservationId,
    type: "generation",
    name: `${input.purpose}.model.step`,
    ...(step.startedAt ? { startedAt: step.startedAt } : {}),
    ...(step.endedAt ? { endedAt: step.endedAt } : {}),
    ...(step.request
      ? { input: summarizeModelRequestForTrace(step.request) }
      : {}),
    ...(step.response
      ? { output: summarizeModelResponseForTrace(step.response) }
      : {}),
    ...(step.request?.model ? { model: step.request.model } : {}),
    ...(step.response?.usage !== undefined ? { usage: step.response.usage } : {}),
    metadata: {
      purpose: input.purpose,
      stepIndex: index,
      ...(step.request?.provider ? { provider: step.request.provider } : {}),
      ...(step.request?.model ? { model: step.request.model } : {}),
      ...(step.request?.temperature !== undefined
        ? { temperature: step.request.temperature }
        : {}),
      ...(step.response?.finishReason
        ? { finishReason: step.response.finishReason }
        : {}),
      ...(step.response?.cacheUsage
        ? {
            cacheReadTokens: step.response.cacheUsage.readTokens,
            ...(step.response.cacheUsage.writeTokens !== undefined
              ? { cacheWriteTokens: step.response.cacheUsage.writeTokens }
              : {})
          }
        : {})
    }
  }));
}

function summarizeModelRequestForTrace(
  request: NonNullable<ModelStepTraceSnapshot["request"]>
): Record<string, unknown> {
  return {
    provider: request.provider,
    model: request.model,
    temperature: request.temperature,
    stepNumber: request.stepNumber,
    messageCount: request.messageCount ?? request.messages?.length ?? 0,
    messagesHash:
      request.messagesHash ?? hashTraceValue(request.messages ?? []),
    tools: request.tools,
    ...(request.toolChoice !== undefined
      ? { toolChoice: sanitizeUntrustedValue(request.toolChoice) }
      : {}),
    ...(request.prompt ? { prompt: request.prompt } : {})
  };
}

function summarizeModelResponseForTrace(
  response: NonNullable<ModelStepTraceSnapshot["response"]>
): Record<string, unknown> {
  return {
    ...(response.stepNumber !== undefined
      ? { stepNumber: response.stepNumber }
      : {}),
    ...(response.content
      ? { content: truncateForTrace(response.content) }
      : {}),
    ...(response.finishReason ? { finishReason: response.finishReason } : {}),
    ...(response.toolCalls
      ? { toolCalls: sanitizeUntrustedValue(response.toolCalls) }
      : {}),
    ...(response.toolResults
      ? { toolResults: sanitizeUntrustedValue(response.toolResults) }
      : {}),
    ...(response.usage !== undefined ? { usage: response.usage } : {}),
    ...(response.cacheUsage ? { cacheUsage: response.cacheUsage } : {}),
    ...(response.requestBody !== undefined
      ? { requestBody: summarizeOpaqueBody(response.requestBody) }
      : {}),
    ...(response.responseBody !== undefined
      ? { responseBody: summarizeOpaqueBody(response.responseBody) }
      : {})
  };
}

function summarizeOpaqueBody(value: unknown): Record<string, unknown> {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  return {
    byteLength: Buffer.byteLength(serialized, "utf8"),
    sha256: createHash("sha256").update(serialized).digest("hex")
  };
}

function hashTraceValue(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function createToolObservation(
  traceId: string,
  parentObservationId: string,
  toolResult: ToolExecutionResult
): ObservationRecord {
  return {
    id: randomUUID(),
    traceId,
    parentObservationId,
    type: "tool",
    name: toolResult.proposal.toolName,
    startedAt: toolResult.proposal.proposedAt,
    endedAt: toolResult.executedAt,
    input: toolResult.proposal.params,
    output: toolResult.result,
    metadata: {
      proposalId: toolResult.proposal.id,
      status: toolResult.status,
      ...(toolResult.proposal.reason
        ? { reason: toolResult.proposal.reason }
        : {}),
      ...(toolResult.reason ? { resultReason: toolResult.reason } : {})
    },
    ...(toolResult.status === "failed" ||
    toolResult.status === "result_unknown"
      ? { level: "ERROR" as const }
      : {})
  };
}

function createDreamingCommandObservation(
  traceId: string,
  parentObservationId: string,
  command: {
    command: string;
    stdout: string;
    stderr: string;
    exitCode: number;
  },
  index: number
): ObservationRecord {
  return {
    id: randomUUID(),
    traceId,
    parentObservationId,
    type: "tool",
    name: "dreaming.bash",
    input: { command: command.command },
    output: {
      exitCode: command.exitCode,
      stdout: truncateForTrace(command.stdout),
      stderr: truncateForTrace(command.stderr)
    },
    metadata: { commandIndex: index },
    ...(command.exitCode === 0 ? {} : { level: "ERROR" as const })
  };
}

function spanToObservation(
  span: SpanRecord,
  level: ObservationRecord["level"] = "DEFAULT"
): ObservationRecord {
  const { status, error, ...metadata } = span.attributes;
  return {
    id: span.id,
    traceId: span.traceId,
    ...(span.parentSpanId ? { parentObservationId: span.parentSpanId } : {}),
    type: "span",
    name: span.name,
    startedAt: span.startedAt,
    endedAt: span.endedAt,
    metadata: {
      ...metadata,
      status
    },
    level,
    ...(typeof error === "string" ? { statusMessage: error } : {})
  };
}

function summarizeModelResponsesForTrace(
  responses: ModelStepTraceSnapshot["response"][] | undefined
): Record<string, unknown>[] {
  return (responses ?? [])
    .filter(
      (response): response is NonNullable<ModelStepTraceSnapshot["response"]> =>
        Boolean(response)
    )
    .map((response) => ({
      ...(response.stepNumber !== undefined
      ? { stepNumber: response.stepNumber }
      : {}),
      ...(response.finishReason ? { finishReason: response.finishReason } : {}),
      ...(response.content !== undefined
      ? { content: truncateForTrace(response.content) }
      : {}),
      ...(response.toolCalls !== undefined ? { toolCalls: response.toolCalls } : {}),
      ...(response.toolResults !== undefined
      ? { toolResults: response.toolResults }
      : {}),
      ...(response.usage !== undefined ? { usage: response.usage } : {}),
      ...(response.cacheUsage !== undefined
        ? { cacheUsage: response.cacheUsage }
        : {})
    }));
}

function truncateForTrace(value: string): string {
  return value.length <= 500 ? value : `${value.slice(0, 500)}...`;
}
