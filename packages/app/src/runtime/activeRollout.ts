import { createHash, randomUUID } from "node:crypto";
import type { GestaltConfig } from "../home/loadConfig";
import type { GestaltHome } from "../home/resolveGestaltHome";
import type {
  ModelExchangeSink,
  ModelExchangeSnapshot,
  ModelExchangeStartedSnapshot,
  ModelRequestTraceSnapshot
} from "../model/session";
import {
  createRolloutWriter,
  resolveTraceBinaryCaptureEnabled,
  type MessageCommitSource,
  type OperationStatus,
  type RolloutMessage,
  type RolloutTerminalStatus,
  type RolloutWriter
} from "../rollout";
import type { SpanRecord } from "../trace/schemas";
import type { ToolExecutionResult } from "../tools/executeActions";
import type { ActionProposal, ToolDefinition } from "../tools/schemas";

const RECENT_SPAN_ID_WINDOW = 4_096;

export interface CreateActiveRolloutOptions {
  home: GestaltHome;
  config: GestaltConfig;
  rolloutId: string;
  activeLoopId: string;
  conversationKey: string;
  eventId?: string;
  tools: readonly ToolDefinition[];
  startedAt: string;
  now: () => Date;
}

export interface ActiveRollout {
  readonly id: string;
  readonly exchangeSink: ModelExchangeSink;
  recordToolStarted(
    proposal: ActionProposal,
    outbound: boolean
  ): Promise<void>;
  recordToolFinished(
    proposal: ActionProposal,
    result: ToolExecutionResult,
    outbound: boolean
  ): Promise<void>;
  recordSpans(spans: readonly SpanRecord[]): Promise<void>;
  close(status: RolloutTerminalStatus, reason?: string): Promise<void>;
}

export function createActiveRollout(
  options: CreateActiveRolloutOptions
): ActiveRollout {
  const writerPromise = createRolloutWriter({
    tracesDir: options.home.tracesDir,
    rolloutId: options.rolloutId,
    activeLoopId: options.activeLoopId,
    binaryCaptureEnabled: resolveTraceBinaryCaptureEnabled(options.config),
    startedAt: options.startedAt,
    now: options.now
  }).then(async (writer) => {
    await writer.append({
      id: randomUUID(),
      rolloutId: options.rolloutId,
      timestamp: options.startedAt,
      type: "rollout_started",
      activeLoopId: options.activeLoopId,
      conversationKey: options.conversationKey,
      ...(options.eventId ? { eventId: options.eventId } : {})
    });
    return writer;
  });
  let committedMessageCount = 0;
  let committedPrefixHash = emptyMessagePrefixHash();
  const recordedSpanIds = new RecentStringSet(RECENT_SPAN_ID_WINDOW);
  const toolStartedAt = new Map<string, string>();
  let operationTail: Promise<void> = Promise.resolve();
  let initialized = false;
  let closed = false;
  const pendingExchangeIds = new Set<string>();

  const enqueue = (
    operation: (writer: RolloutWriter) => Promise<void>
  ): Promise<void> => {
    if (closed) {
      return Promise.reject(new Error("Active rollout is already closed."));
    }
    const result = operationTail.then(async () => operation(await writerPromise));
    operationTail = result;
    return result;
  };

  const exchangeSink: ModelExchangeSink = {
    onStepStarted(exchange) {
      return enqueue((writer) => recordExchangeStarted(writer, exchange));
    },
    onStepCompleted(exchange) {
      return enqueue((writer) => recordExchangeCompleted(writer, exchange));
    },
    async flush() {
      await operationTail;
      const writer = await writerPromise;
      await writer.flush();
    }
  };

  return {
    id: options.rolloutId,
    exchangeSink,

    async recordToolStarted(proposal, outbound) {
      toolStartedAt.set(proposal.id, options.now().toISOString());
      if (!outbound) {
        return;
      }
      await enqueue(async (writer) => {
        await writer.append({
          id: randomUUID(),
          rolloutId: options.rolloutId,
          timestamp: options.now().toISOString(),
          type: "outbound_action_started",
          actionId: proposal.id,
          toolName: proposal.toolName,
          params: proposal.params
        });
        // This is the safety boundary: the external call may only happen after
        // the intent is on durable storage.
        await writer.flush({ durable: true });
      });
    },

    async recordToolFinished(proposal, result, outbound) {
      await enqueue(async (writer) => {
        const timestamp = options.now().toISOString();
        const startedAt = toolStartedAt.get(proposal.id);
        const durationMs = startedAt
          ? Math.max(0, Date.parse(timestamp) - Date.parse(startedAt))
          : undefined;
        const status = operationStatus(result);
        if (outbound && result.status !== "result_unknown") {
          await writer.append({
            id: randomUUID(),
            rolloutId: options.rolloutId,
            timestamp,
            type: "outbound_action_finished",
            actionId: proposal.id,
            status,
            ...(durationMs !== undefined ? { durationMs } : {}),
            ...(result.result !== undefined ? { result: result.result } : {}),
            ...(result.reason ? { errorCode: result.reason } : {})
          });
        }
        await writer.append({
          id: randomUUID(),
          rolloutId: options.rolloutId,
          timestamp,
          type: "tool_completed",
          toolCallId: proposal.id,
          toolName: proposal.toolName,
          status,
          ...(startedAt ? { startedAt } : {}),
          ...(durationMs !== undefined ? { durationMs } : {}),
          input: proposal.params,
          ...(result.result !== undefined ? { output: result.result } : {}),
          ...(result.status === "result_unknown"
            ? { errorCode: "result_unknown_after_dispatch" }
            : result.reason
              ? { errorCode: result.reason }
              : {})
        });
        if (outbound) {
          await writer.flush({ durable: true });
        }
        toolStartedAt.delete(proposal.id);
      });
    },

    async recordSpans(spans) {
      for (const span of spans) {
        if (recordedSpanIds.has(span.id)) {
          continue;
        }
        recordedSpanIds.add(span.id);
        await enqueue(async (writer) => {
          await writer.append({
            id: randomUUID(),
            rolloutId: options.rolloutId,
            timestamp: span.endedAt,
            type: "span_completed",
            spanId: span.id,
            ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
            name: span.name,
            startedAt: span.startedAt,
            endedAt: span.endedAt,
            status: span.attributes.error ? "failed" : "succeeded",
            attributes: span.attributes
          });
        });
      }
    },

    async close(status, reason) {
      if (closed) {
        await operationTail;
        return;
      }
      await exchangeSink.flush?.();
      await operationTail;
      closed = true;
      const writer = await writerPromise;
      await writer.close(status, reason ? { reason } : {});
    }
  };

  async function recordExchangeStarted(
    writer: RolloutWriter,
    exchange: ModelExchangeStartedSnapshot
  ): Promise<void> {
    if (pendingExchangeIds.has(exchange.exchangeId)) {
      throw new Error(`Model exchange ${exchange.exchangeId} was already started.`);
    }
    const requestMessages = normalizeMessages(exchange.request.messages ?? []);
    if (!initialized) {
      const prefixLength = initialPrefixLength(requestMessages);
      const initialMessages = requestMessages.slice(0, prefixLength);
      const messages = initialMessages.map((message) => createMessage(message));
      const definitionsByName = new Map<string, ToolDefinition>(
        options.tools.map((definition) => [definition.name, definition])
      );
      const tools =
        exchange.request.toolProtocol !== undefined
          ? exchange.request.toolProtocol
          : exchange.request.tools.map(
              (name) => definitionsByName.get(name) ?? { name }
            );
      await writer.append({
        id: randomUUID(),
        rolloutId: options.rolloutId,
        timestamp: exchange.startedAt ?? options.now().toISOString(),
        type: "model_session_initialized",
        messages,
        tools,
        provider: exchange.request.provider,
        model: exchange.request.model,
        metadata: {
          purpose: exchange.purpose,
          prompt: exchange.request.prompt ?? null,
          sessionId: exchange.request.sessionId ?? null,
          promptCacheEnabled: exchange.request.promptCacheEnabled ?? false
        }
      });
      for (const message of initialMessages) {
        advanceCommittedPrefix(message);
      }
      initialized = true;
      for (const message of requestMessages.slice(prefixLength)) {
        await commitMessage(writer, message, "user");
      }
    } else {
      assertCommittedPrefix(requestMessages);
      for (const message of requestMessages.slice(committedMessageCount)) {
        await commitMessage(writer, message, inputSource(exchange, message.role));
      }
    }
    pendingExchangeIds.add(exchange.exchangeId);
  }

  async function recordExchangeCompleted(
    writer: RolloutWriter,
    exchange: ModelExchangeSnapshot
  ): Promise<void> {
    if (!pendingExchangeIds.delete(exchange.exchangeId)) {
      throw new Error(
        `Model exchange ${exchange.exchangeId} completed without a matching start.`
      );
    }
    const generationId = randomUUID();
    const outputMessages =
      exchange.status === "cancelled" || !exchange.response
        ? []
        : normalizeMessages(
            exchange.response.messages ?? synthesizeOutput(exchange.response)
          );
    const rolloutMessages = outputMessages.map((message, index) =>
      createMessage(message, `${generationId}:output:${index}`)
    );
    const durationMs = durationBetween(exchange.startedAt, exchange.endedAt);
    await writer.append({
      id: randomUUID(),
      rolloutId: options.rolloutId,
      timestamp: exchange.endedAt ?? options.now().toISOString(),
      type: "generation_completed",
      generationId,
      outputMessageIds: rolloutMessages.map((message) => message.id),
      status: exchange.status,
      provider: exchange.request.provider,
      model: exchange.request.model,
      parameters: {
        temperature: exchange.request.temperature,
        stepNumber: exchange.request.stepNumber,
        toolChoice: exchange.request.toolChoice ?? null,
        promptCacheEnabled: exchange.request.promptCacheEnabled ?? false
      },
      ...(exchange.response?.finishReason
        ? { finishReason: exchange.response.finishReason }
        : {}),
      ...(exchange.response?.usage !== undefined
        ? { usage: exchange.response.usage }
        : {}),
      ...(exchange.response?.cacheUsage
        ? { cacheUsage: exchange.response.cacheUsage }
        : {}),
      ...(durationMs !== undefined ? { latencyMs: durationMs } : {}),
      metadata: {
        purpose: exchange.purpose,
        requestBody: hashAndLength(exchange.request.requestBody),
        ...(exchange.response
          ? { responseBody: hashAndLength(exchange.response.responseBody) }
          : {})
      }
    });
    for (let index = 0; index < outputMessages.length; index += 1) {
      const message = outputMessages[index];
      const rolloutMessage = rolloutMessages[index];
      if (!message || !rolloutMessage) {
        continue;
      }
      await commitMessage(
        writer,
        message,
        outputSource(exchange, message.role),
        rolloutMessage
      );
    }
  }

  function assertCommittedPrefix(
    requestMessages: readonly NormalizedMessage[]
  ): void {
    if (requestMessages.length < committedMessageCount) {
      throw new Error(
        "Model request removed committed rollout messages; canonical state cannot rewind."
      );
    }
    if (
      messagePrefixHash(requestMessages, committedMessageCount) !==
      committedPrefixHash
    ) {
      throw new Error(
        "Model request diverged from committed rollout state."
      );
    }
  }

  async function commitMessage(
    writer: RolloutWriter,
    message: NormalizedMessage,
    source: MessageCommitSource,
    prepared = createMessage(message)
  ): Promise<void> {
    await writer.append({
      id: randomUUID(),
      rolloutId: options.rolloutId,
      timestamp: options.now().toISOString(),
      type: "message_committed",
      message: prepared,
      source
    });
    advanceCommittedPrefix(message);
  }

  function advanceCommittedPrefix(message: NormalizedMessage): void {
    committedPrefixHash = advanceMessagePrefixHash(
      committedPrefixHash,
      message
    );
    committedMessageCount += 1;
  }
}

interface NormalizedMessage {
  role: string;
  content: unknown;
}

function normalizeMessages(messages: readonly unknown[]): NormalizedMessage[] {
  return messages.map((message) => {
    if (!message || typeof message !== "object") {
      return { role: "unknown", content: message };
    }
    const record = message as Record<string, unknown>;
    return {
      role: typeof record.role === "string" ? record.role : "unknown",
      content: record.content ?? ""
    };
  });
}

function createMessage(
  message: NormalizedMessage,
  id = randomUUID()
): RolloutMessage {
  return { id, role: message.role, content: message.content };
}

function initialPrefixLength(messages: readonly NormalizedMessage[]): number {
  let length = 0;
  while (
    length < messages.length &&
    (messages[length]?.role === "system" ||
      messages[length]?.role === "developer")
  ) {
    length += 1;
  }
  return length;
}

function messageFingerprint(message: NormalizedMessage): string {
  return createHash("sha256")
    .update(JSON.stringify([message.role, message.content]))
    .digest("hex");
}

function emptyMessagePrefixHash(): string {
  return createHash("sha256").update("gestalt.rollout.prefix").digest("hex");
}

function advanceMessagePrefixHash(
  previous: string,
  message: NormalizedMessage
): string {
  return createHash("sha256")
    .update(previous)
    .update("\0")
    .update(messageFingerprint(message))
    .digest("hex");
}

function messagePrefixHash(
  messages: readonly NormalizedMessage[],
  count: number
): string {
  let hash = emptyMessagePrefixHash();
  for (let index = 0; index < count; index += 1) {
    const message = messages[index];
    if (!message) {
      throw new Error("Model request is missing a committed prefix message.");
    }
    hash = advanceMessagePrefixHash(hash, message);
  }
  return hash;
}

function synthesizeOutput(
  response: NonNullable<ModelExchangeSnapshot["response"]>
): unknown[] {
  const output: unknown[] = [];
  if (response.content) {
    output.push({ role: "assistant", content: response.content });
  }
  if (response.toolCalls?.length) {
    output.push({ role: "assistant", content: response.toolCalls });
  }
  for (const result of response.toolResults ?? []) {
    output.push({ role: "tool", content: result });
  }
  return output;
}

function inputSource(
  exchange: ModelExchangeStartedSnapshot,
  role: string
): MessageCommitSource {
  if (exchange.purpose === "dreaming") {
    return "dreaming";
  }
  if (role === "assistant") {
    return "assistant";
  }
  if (role === "tool") {
    return "tool";
  }
  return "steer";
}

function outputSource(
  exchange: ModelExchangeSnapshot,
  role: string
): MessageCommitSource {
  if (exchange.purpose === "dreaming") {
    return "dreaming";
  }
  return role === "tool" ? "tool" : "assistant";
}

function operationStatus(result: ToolExecutionResult): OperationStatus {
  if (result.status === "executed") {
    return "succeeded";
  }
  if (result.status === "failed") {
    return "failed";
  }
  if (result.status === "result_unknown") {
    return "failed";
  }
  return "cancelled";
}

function durationBetween(
  startedAt: string | undefined,
  endedAt: string | undefined
): number | undefined {
  if (!startedAt || !endedAt) {
    return undefined;
  }
  const duration = Date.parse(endedAt) - Date.parse(startedAt);
  return Number.isFinite(duration) ? Math.max(0, duration) : undefined;
}

function hashAndLength(value: unknown):
  | { sha256: string; byteLength: number }
  | null {
  if (value === undefined) {
    return null;
  }
  let serialized: string;
  try {
    serialized = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    serialized = String(value);
  }
  return {
    sha256: createHash("sha256").update(serialized).digest("hex"),
    byteLength: Buffer.byteLength(serialized, "utf8")
  };
}

class RecentStringSet {
  private readonly values = new Map<string, undefined>();

  constructor(private readonly limit: number) {}

  has(value: string): boolean {
    return this.values.has(value);
  }

  add(value: string): void {
    this.values.delete(value);
    this.values.set(value, undefined);
    if (this.values.size <= this.limit) {
      return;
    }
    const oldest = this.values.keys().next().value;
    if (oldest !== undefined) {
      this.values.delete(oldest);
    }
  }
}
