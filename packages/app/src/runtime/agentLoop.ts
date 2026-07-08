import { randomUUID } from "node:crypto";
import { compileContext } from "../context/compileContext";
import { renderConversationTranscript } from "../context/renderTranscript";
import { selectContextEvents } from "../context/selectContextEvents";
import type { CanonicalEvent } from "../events/schemas";
import type { Connector } from "../connectors/types";
import type { GestaltConfig } from "../home/loadConfig";
import type { GestaltHome } from "../home/resolveGestaltHome";
import type { DreamingRunResult, DreamingRunner } from "../memory/dreaming";
import type { MemoryStore } from "../memory/store";
import type { ModelClient } from "../model/proposeActions";
import type { PersonaPack } from "../persona/loadPersona";
import type {
  MessageWindow,
  SessionEventRecord,
  TurnPhase,
  TurnPhaseRecord
} from "../session/schemas";
import type { SessionStore } from "../session/store";
import { createTraceRecorder, type TraceRecorder } from "../trace/recorder";
import type { AgentTurnTrace, SpanRecord } from "../trace/schemas";
import {
  executeActions,
  type ToolExecutionResult,
  type ToolImplementations
} from "../tools/executeActions";
import type { ActionProposal, ToolDefinition } from "../tools/schemas";
import { throwIfTurnSteered } from "./turnSignals";

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
  traceRecorder?: TraceRecorder;
  toolImplementations?: ToolImplementations;
  now: () => Date;
}

export interface RunAgentTurnInput {
  window: MessageWindow;
  eventRecords: SessionEventRecord[];
  steerCount: number;
  includeSelfHistory?: boolean;
  signal?: AbortSignal;
  onPhaseChange?: (phase: TurnPhase) => void;
}

export interface RunDreamingForAgentTurnInput {
  window: MessageWindow;
  eventRecords: SessionEventRecord[];
  proposedActions: ActionProposal[];
  toolResults: ToolExecutionResult[];
}

export async function runAgentTurn(
  dependencies: AgentLoopDependencies,
  input: RunAgentTurnInput
): Promise<AgentTurnResult> {
  const traceId = randomUUID();
  const traceStartedAt = dependencies.now().toISOString();
  const spans: SpanRecord[] = [];
  const phases: TurnPhaseRecord[] = [];
  const event = getCurrentEvent(input.eventRecords);

  const markPhase = (phase: TurnPhase): void => {
    const record: TurnPhaseRecord = {
      phase,
      at: dependencies.now().toISOString()
    };
    phases.push(record);
    input.onPhaseChange?.(phase);
  };

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
    dependencies.now,
    () =>
      dependencies.memoryStore.findRelevantMemories({
        event,
        windowEvents: contextEventRecords
      }),
    {
      strategy: "file-indexes",
      windowId: input.window.id,
      fromSeq: input.window.fromSeq,
      toSeq: input.window.toSeq,
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
  const context = await runSpan(
    traceId,
    "context.compile",
    spans,
    dependencies.now,
    () =>
      compileContext({
        event,
        window: input.window,
        windowEvents: input.eventRecords,
        contextEvents,
        persona: dependencies.persona,
        memories,
        tools: dependencies.tools,
        config: dependencies.config
      }),
    {
      personaVersion: dependencies.persona.version,
      personaFragments: dependencies.persona.fragments.length,
      memoryFragments: memories.length,
      tools: dependencies.tools.map((tool) => tool.name),
      windowReason: input.window.reason,
      windowEventCount: input.eventRecords.length,
      contextEventCount: contextEvents.length,
      steerCount: input.steerCount
    }
  );

  markPhase("model_running");
  throwIfTurnSteered(input.signal);
  const modelResult = await runSpan(
    traceId,
    "model.decide",
    spans,
    dependencies.now,
    () =>
      dependencies.model.proposeActions(
        context,
        {
          ...(input.signal ? { signal: input.signal } : {}),
          connector: dependencies.connector,
          now: dependencies.now,
          ...(dependencies.toolImplementations
            ? { toolImplementations: dependencies.toolImplementations }
            : {})
        }
      ),
    { model: dependencies.model.name ?? "unknown" }
  );
  const proposedActions = modelResult.proposedActions;

  markPhase("executing");
  throwIfTurnSteered(input.signal);
  const toolResults = await runSpan(
    traceId,
    "tool.execute",
    spans,
    dependencies.now,
    () => {
      if (modelResult.toolResults) {
        return modelResult.toolResults;
      }
      return executeActions({
        connector: dependencies.connector,
        proposals: proposedActions,
        now: dependencies.now,
        ...(dependencies.toolImplementations
          ? { toolImplementations: dependencies.toolImplementations }
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
    })
  );
  markPhase("completed");

  const trace: AgentTurnTrace = {
    id: traceId,
    name: "agent.turn",
    startedAt: traceStartedAt,
    endedAt: dependencies.now().toISOString(),
    gestaltHome: dependencies.home.root,
    eventId: event.id,
    personaVersion: dependencies.persona.version,
    spans,
    proposedActions,
    toolResults
  };

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
    windowEvents: input.eventRecords
  });

  const dreamingResult = await runSpan(
    result.traceId,
    "dream.run",
    result.trace.spans,
    dependencies.now,
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
        now: dependencies.now
      }),
    {
      windowId: input.window.id,
      fromSeq: input.window.fromSeq,
      toSeq: input.window.toSeq,
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
      ...(dreamResult.error ? { error: dreamResult.error } : {})
    })
  );
  result.dreamingResult = dreamingResult;
  result.trace.endedAt = dependencies.now().toISOString();
  return dreamingResult;
}

export async function recordAgentTurnTrace(
  dependencies: AgentLoopDependencies,
  result: AgentTurnResult
): Promise<void> {
  const traceRecorder =
    dependencies.traceRecorder ?? createTraceRecorder(dependencies.home);
  result.trace.endedAt = dependencies.now().toISOString();
  await traceRecorder.recordAgentTurn(result.trace);
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
  now: () => Date,
  operation: () => T | Promise<T>,
  attributes: Record<string, unknown> = {},
  resultAttributes?: (result: T) => Record<string, unknown>
): Promise<T> {
  const spanId = randomUUID();
  const startedAt = now().toISOString();
  try {
    const result = await operation();
    spans.push({
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
    });
    return result;
  } catch (error) {
    spans.push({
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
    });
    throw error;
  }
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

function truncateForTrace(value: string): string {
  return value.length <= 500 ? value : `${value.slice(0, 500)}...`;
}
