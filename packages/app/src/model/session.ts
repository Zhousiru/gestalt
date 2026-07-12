import { randomUUID } from "node:crypto";
import type { ModelMessage } from "ai";
import type { CompiledContext } from "../context/compileContext";
import type { MessageReceivedEvent } from "../events/schemas";
import {
  throwIfTurnSteered,
  waitForTurnDelay
} from "../runtime/turnSignals";
import type { Connector } from "../connectors/types";
import type {
  ToolExecutionResult,
  ToolImplementations
} from "../tools/executeActions";
import type { ActionProposal, ToolDefinition } from "../tools/schemas";
import type { PromptMetadata } from "../prompts/types";

export interface ModelClient {
  name?: string;
  createSession(options?: CreateModelSessionOptions): ModelSession;
}

export type ModelExchangePurpose = "agent_action" | "dreaming";

export interface ModelExchangeStartedSnapshot {
  exchangeId: string;
  purpose: ModelExchangePurpose;
  request: ModelRequestTraceSnapshot;
  startedAt?: string;
}

export interface ModelExchangeSnapshot extends ModelExchangeStartedSnapshot {
  response?: ModelResponseTraceSnapshot;
  status: "completed" | "failed" | "cancelled";
  endedAt?: string;
}

export interface ModelExchangeSink {
  onStepStarted(exchange: ModelExchangeStartedSnapshot): void | Promise<void>;
  onStepCompleted(exchange: ModelExchangeSnapshot): void | Promise<void>;
  flush?(): Promise<void>;
}

export interface CreateModelSessionOptions {
  exchangeSink?: ModelExchangeSink;
}

/**
 * One model conversation for one active agent loop.
 *
 * A session owns the append-only model message history. `run` appends a normal
 * input window, while `steer` appends newer input and interrupts only the
 * currently running model attempt. Completed assistant/tool steps remain part
 * of the session after a steer.
 */
export interface ModelSession {
  readonly initialized: boolean;
  readonly running: boolean;
  run(
    context: CompiledContext,
    options?: ModelRunOptions
  ): Promise<ModelActionResult>;
  steer(context: CompiledContext): boolean;
  continuation?(): ModelSessionContinuation | undefined;
}

/**
 * Immutable hand-off from an action session to a terminal model phase.
 *
 * The terminal phase must preserve `instructions` and `messages` verbatim,
 * append its own user message, and reuse `providerSessionId` so providers can
 * reuse the already-computed prompt prefix.
 */
export interface ModelSessionContinuation {
  instructions: string;
  prompt: PromptMetadata;
  messages: readonly ModelMessage[];
  providerSessionId: string;
  promptCacheEnabled: boolean;
  promptCacheTtl?: "5m" | "1h";
  actionTools: readonly ToolDefinition[];
  exchangeSink?: ModelExchangeSink;
}

export interface ModelActionResult {
  proposedActions: ActionProposal[];
  toolResults?: ToolExecutionResult[];
  modelResponses?: ModelResponseTraceSnapshot[];
  modelSteps?: ModelStepTraceSnapshot[];
}

export interface ModelStepTraceSnapshot {
  startedAt?: string;
  endedAt?: string;
  request?: ModelRequestTraceSnapshot;
  response?: ModelResponseTraceSnapshot;
}

export interface ModelRequestTraceSnapshot {
  provider: string;
  model: string;
  temperature: number;
  stepNumber: number;
  messages?: unknown[];
  messageCount?: number;
  messagesHash?: string;
  tools: string[];
  toolProtocol?: unknown[];
  toolChoice?: unknown;
  requestBody?: unknown;
  prompt?: PromptMetadata;
  sessionId?: string;
  promptCacheEnabled?: boolean;
}

export interface ModelResponseTraceSnapshot {
  content?: string;
  messages?: unknown[];
  finishReason?: string;
  stepNumber?: number;
  toolCalls?: unknown[];
  toolResults?: unknown[];
  usage?: unknown;
  cacheUsage?: {
    readTokens: number;
    writeTokens?: number;
  };
  requestBody?: unknown;
  responseBody?: unknown;
}

export interface ModelRunOptions {
  signal?: AbortSignal;
  connector?: Connector;
  now?: () => Date;
  traceId?: string;
  toolImplementations?: ToolImplementations;
  onModelAttemptStart?: () => void;
  onModelStepCommitted?: () => void | Promise<void>;
  onToolExecutionStart?: (
    proposal: ActionProposal
  ) => void | Promise<void>;
  onToolExecutionEnd?: (
    proposal: ActionProposal,
    result: ToolExecutionResult
  ) => void | Promise<void>;
}

const modelStepsErrorKey = "__gestaltModelSteps";

export function attachModelStepsToError(
  error: unknown,
  modelSteps: ModelStepTraceSnapshot[]
): void {
  if (!error || typeof error !== "object") {
    return;
  }
  (error as { [modelStepsErrorKey]?: ModelStepTraceSnapshot[] })[
    modelStepsErrorKey
  ] = modelSteps;
}

export function readModelStepsFromError(
  error: unknown
): ModelStepTraceSnapshot[] | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const value = (error as { [modelStepsErrorKey]?: unknown })[modelStepsErrorKey];
  return Array.isArray(value) ? (value as ModelStepTraceSnapshot[]) : undefined;
}

export interface CreateMockModelOptions {
  now?: () => Date;
  delayMs?: number;
}

export function createMockModel(options: CreateMockModelOptions = {}): ModelClient {
  const now = options.now ?? (() => new Date());
  const delayMs = options.delayMs ?? 0;

  return {
    name: "mock",
    createSession(sessionOptions = {}) {
      return createMockModelSession(
        now,
        delayMs,
        sessionOptions.exchangeSink
      );
    }
  };
}

function createMockModelSession(
  now: () => Date,
  delayMs: number,
  exchangeSink?: ModelExchangeSink
): ModelSession {
  let currentContext: CompiledContext | undefined;
  let attemptController: AbortController | undefined;
  let initialized = false;
  let running = false;
  const messages: Array<{ role: string; content: string }> = [];

  return {
    get initialized() {
      return initialized;
    },
    get running() {
      return running;
    },

    async run(context, runOptions = {}) {
      if (running) {
        throw new Error("Model session is already running.");
      }
      currentContext = context;
      initialized = true;
      running = true;

      try {
        while (true) {
          const controller = new AbortController();
          attemptController = controller;
          const removeExternalAbort = forwardAbortSignal(
            runOptions.signal,
            controller
          );
          runOptions.onModelAttemptStart?.();

          try {
            await waitForTurnDelay(delayMs, controller.signal);
            throwIfTurnSteered(controller.signal);
            const startedAt = now().toISOString();
            if (messages.length === 0) {
              messages.push({
                role: "system",
                content: currentContext.persona.fragments
                  .map((fragment) => fragment.content)
                  .join("\n\n")
              });
            }
            messages.push({
              role: "user",
              content: currentContext.transcript
            });
            const exchangeId = randomUUID();
            const request: ModelRequestTraceSnapshot = {
              provider: "mock",
              model: "mock",
              temperature: 0,
              stepNumber: 0,
              messages: [...messages],
              tools: currentContext.tools.map((tool) => tool.name),
              toolProtocol: currentContext.tools
            };
            await exchangeSink?.onStepStarted({
              exchangeId,
              purpose: "agent_action",
              request,
              startedAt
            });
            const result = proposeMockActions(currentContext, now);
            const responseMessage = {
              role: "assistant",
              content: JSON.stringify(result.proposedActions)
            };
            await exchangeSink?.onStepCompleted({
              exchangeId,
              purpose: "agent_action",
              request,
              response: {
                messages: [responseMessage],
                finishReason: "stop",
                stepNumber: 0,
                toolCalls: result.proposedActions.map((proposal) => ({
                  id: proposal.id,
                  name: proposal.toolName,
                  input: proposal.params
                }))
              },
              status: "completed",
              startedAt,
              endedAt: now().toISOString()
            });
            messages.push(responseMessage);
            await runOptions.onModelStepCommitted?.();
            throwIfTurnSteered(controller.signal);
            return result;
          } catch (error) {
            if (
              error instanceof Error &&
              error.name === "AbortError" &&
              !runOptions.signal?.aborted
            ) {
              continue;
            }
            throw error;
          } finally {
            removeExternalAbort();
          }
        }
      } finally {
        running = false;
        attemptController = undefined;
      }
    },

    steer(context) {
      if (!running) {
        return false;
      }
      currentContext = context;
      attemptController?.abort();
      return true;
    }
  };
}

function proposeMockActions(
  context: CompiledContext | undefined,
  now: () => Date
): ModelActionResult {
  if (!context) {
    throw new Error("Mock model session has no context.");
  }
  const event = selectCurrentMessageEvent(context);
  const proposedAt = now().toISOString();

  if (event.message.text.includes("退出循环") || event.message.text.includes("leave loop")) {
    return {
      proposedActions: [
        {
          id: randomUUID(),
          proposedAt,
          toolName: "leave",
          reason: "Mock model saw an explicit request to leave the active loop.",
          params: {}
        }
      ]
    };
  }

  if (event.conversation.kind === "group" && event.message.mentionsBot) {
    return {
      proposedActions: [
        {
          id: randomUUID(),
          proposedAt,
          toolName: "send_group_message",
          reason: "Mock model saw a direct group mention in the current window.",
          params: {
            groupId: event.conversation.id,
            text: `[CQ:reply,id=${event.message.id}]在，我看到了。`
          }
        }
      ]
    };
  }

  return {
    proposedActions: [
      {
        id: randomUUID(),
        proposedAt,
        toolName: "say_nothing",
        reason: "Mock model found no direct cue that requires a response.",
        params: {}
      }
    ]
  };
}

function forwardAbortSignal(
  source: AbortSignal | undefined,
  target: AbortController
): () => void {
  if (!source) {
    return () => undefined;
  }
  const abort = () => target.abort(source.reason);
  if (source.aborted) {
    abort();
    return () => undefined;
  }
  source.addEventListener("abort", abort, { once: true });
  return () => source.removeEventListener("abort", abort);
}

function selectCurrentMessageEvent(
  context: CompiledContext
): MessageReceivedEvent {
  const windowEvents =
    context.window?.events
      .map((record) => record.event)
      .filter(
        (event): event is MessageReceivedEvent => event.type === "MessageReceived"
      ) ?? [];
  const mentionedEvent = windowEvents
    .filter(
      (event) =>
        event.conversation.kind === "group" && event.message.mentionsBot
    )
    .at(-1);

  if (mentionedEvent) {
    return mentionedEvent;
  }

  if (context.event.type === "MessageReceived") {
    return context.event;
  }

  const fallbackEvent = windowEvents.at(-1);
  if (fallbackEvent) {
    return fallbackEvent;
  }

  throw new Error("Mock model requires at least one message event.");
}
