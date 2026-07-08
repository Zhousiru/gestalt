import { randomUUID } from "node:crypto";
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
import type { ActionProposal } from "../tools/schemas";

export interface ModelClient {
  name?: string;
  proposeActions(
    context: CompiledContext,
    options?: ModelRunOptions
  ): Promise<ModelActionResult>;
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
  messages: unknown[];
  tools: string[];
  toolChoice?: unknown;
  requestBody?: unknown;
}

export interface ModelResponseTraceSnapshot {
  content?: string;
  finishReason?: string;
  stepNumber?: number;
  toolCalls?: unknown[];
  toolResults?: unknown[];
  usage?: unknown;
  requestBody?: unknown;
  responseBody?: unknown;
}

export interface ModelRunOptions {
  signal?: AbortSignal;
  connector?: Connector;
  now?: () => Date;
  toolImplementations?: ToolImplementations;
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

    async proposeActions(context, runOptions = {}) {
      await waitForTurnDelay(delayMs, runOptions.signal);
      throwIfTurnSteered(runOptions.signal);

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

      if (
        event.type === "MessageReceived" &&
        event.conversation.kind === "group" &&
        event.message.mentionsBot
      ) {
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
  };
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
