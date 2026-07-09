import {
  CanonicalEventSchema,
  type CanonicalEvent,
  type Conversation
} from "../events/schemas";
import { isSelfMessageEvent } from "../events/helpers";
import { createMockConnector } from "../connectors/mock/connector";
import type { Connector, ConnectorCallResult } from "../connectors/types";
import { loadEnv } from "../home/loadEnv";
import { loadConfig, type GestaltConfig } from "../home/loadConfig";
import {
  resolveGestaltHome,
  type GestaltHome
} from "../home/resolveGestaltHome";
import {
  createAiSdkDreamingRunner,
  createNoopDreamingRunner,
  type DreamingRunner
} from "../memory/dreaming";
import {
  createAiSdkInspectRunner,
  parseInspectCommand,
  type InspectRunner
} from "../inspect/agent";
import { createFileMemoryStore } from "../memory/store";
import type { LiveEventSink } from "../live/viewTypes";
import {
  createMockModel,
  type ModelClient
} from "../model/proposeActions";
import { loadPersona } from "../persona/loadPersona";
import {
  createInMemorySessionStore,
  getConversationKey,
  type CreatedMessageWindow,
  type ExportSessionOptions
} from "../session/store";
import { createSessionRecorder } from "../session/recorder";
import {
  type MessageWindowReason,
  type SessionEventRecord,
  type SessionSnapshot
} from "../session/schemas";
import { createTraceRecorder } from "../trace/recorder";
import { createDefaultGroupTriggers } from "../triggers/defaultTriggers";
import {
  evaluateGroupTriggers,
  type GroupTrigger
} from "../triggers/types";
import {
  type ToolImplementations
} from "../tools/executeActions";
import { createDefaultToolRegistry } from "../tools/registry";
import type { ToolDefinition } from "../tools/schemas";
import { type AgentTurnResult } from "./agentLoop";
import {
  canInjectIntoActiveLoop,
  clearActiveLoopIdleExit,
  forceActiveLoopExit,
  startActiveLoopWindow,
  type ActiveLoop,
  type ActiveLoopDependencies
} from "./activeLoop";
import {
  createDefaultAgentLoopExitTriggers,
  type AgentLoopExitTrigger
} from "./exitTriggers";

export interface Runtime {
  home: GestaltHome;
  ingestEvent(event: unknown): SessionEventRecord;
  handleEvent(event: unknown): Promise<AgentTurnResult | undefined>;
  handleMessageWindow(
    input: HandleMessageWindowInput
  ): Promise<AgentTurnResult | undefined>;
  exportSession(options?: ExportSessionOptions): SessionSnapshot;
  importSession(snapshot: unknown): void;
  whenIdle(): Promise<void>;
}

export interface HandleMessageWindowInput {
  conversation: Conversation;
  fromSeq: number;
  toSeq: number;
  reason?: MessageWindowReason;
}

export interface CreateRuntimeOptions {
  gestaltHome?: string;
  connector?: Connector;
  model?: ModelClient;
  tools?: ToolDefinition[];
  toolImplementations?: ToolImplementations;
  dreamingRunner?: DreamingRunner;
  inspectRunner?: InspectRunner;
  sessionSnapshot?: unknown;
  maxSteersPerTurn?: number;
  triggers?: GroupTrigger[];
  exitTriggers?: AgentLoopExitTrigger[];
  liveEvents?: LiveEventSink;
  now?: () => Date;
}

interface ActiveLoopAggregationConfig {
  delayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
}

interface ActiveLoopBuffer {
  conversation: Conversation;
  records: SessionEventRecord[];
  nextDelayMs: number;
  timer?: ReturnType<typeof setTimeout>;
}

export async function createRuntime(
  options: CreateRuntimeOptions = {}
): Promise<Runtime> {
  const now = options.now ?? (() => new Date());
  const home = await resolveGestaltHome(
    options.gestaltHome ? { homePath: options.gestaltHome } : {}
  );
  loadEnv(home);
  const config = await loadConfig(home);
  const persona = await loadPersona(home);
  const memoryStore = createFileMemoryStore(home);
  const dreamingRunner =
    options.dreamingRunner ?? createDreamingRunnerFromConfig(config);
  const inspectRunner = options.inspectRunner ?? createAiSdkInspectRunner(config);
  const tools = filterToolsForConfig(
    options.tools ?? createDefaultToolRegistry(),
    config
  );
  const connector = options.connector ?? createMockConnector();
  const model = options.model ?? createMockModel({ now });
  const traceRecorder = createTraceRecorder(home);
  const sessionRecorder = createSessionRecorder(home);
  const sessionStore = createInMemorySessionStore(options.sessionSnapshot, {
    now,
    onEventAppended(record) {
      options.liveEvents?.publish(
        "session.event.appended",
        {
          record
        },
        record.receivedAt
      );
    },
    onWindowCreated(window) {
      options.liveEvents?.publish(
        "session.window.created",
        {
          window
        },
        window.closedAt
      );
    },
    onTurnRecorded(turn) {
      options.liveEvents?.publish(
        "session.turn.recorded",
        {
          turn
        },
        turn.endedAt
      );
    },
    onLoopExitRecorded(exit) {
      options.liveEvents?.publish(
        "session.loop_exit.recorded",
        {
          exit
        },
        exit.endedAt
      );
    },
    onSnapshotChange(snapshot) {
      sessionRecorder.recordSnapshot(snapshot);
      options.liveEvents?.publish(
        "session.snapshot.changed",
        {
          snapshot
        },
        snapshot.exportedAt
      );
    }
  });
  const triggers = options.triggers ?? createDefaultGroupTriggers(config);
  const exitTriggers =
    options.exitTriggers ?? createDefaultAgentLoopExitTriggers(config);
  const activeLoopAggregation = readActiveLoopAggregationConfig(config);
  const allowedGroupIds = readAllowedGroupIds(config);
  const activeTurns = new Map<string, ActiveLoop>();
  const activeLoopBuffers = new Map<string, ActiveLoopBuffer>();

  const dependencies: ActiveLoopDependencies = {
    home,
    config,
    persona,
    memoryStore,
    dreamingRunner,
    tools,
    connector,
    model,
    traceRecorder,
    now,
    sessionStore,
    maxSteersPerTurn: options.maxSteersPerTurn ?? 2,
    ...(options.liveEvents ? { liveEvents: options.liveEvents } : {}),
    ...(options.toolImplementations
      ? { toolImplementations: options.toolImplementations }
      : {})
  };

  const appendParsedEvent = (parsedEvent: CanonicalEvent): SessionEventRecord => {
    return dependencies.sessionStore.appendEvent(parsedEvent, {
      receivedAt: dependencies.now().toISOString()
    });
  };

  const ingestEvent = (event: unknown): SessionEventRecord => {
    return appendParsedEvent(CanonicalEventSchema.parse(event));
  };

  const createMessageWindowPart = (
    input: HandleMessageWindowInput
  ): CreatedMessageWindow =>
    dependencies.sessionStore.createMessageWindow({
      conversation: input.conversation,
      fromSeq: input.fromSeq,
      toSeq: input.toSeq,
      closedAt: dependencies.now().toISOString(),
      ...(input.reason ? { reason: input.reason } : {})
    });

  const startWindowPart = (
    part: CreatedMessageWindow
  ): Promise<AgentTurnResult | undefined> =>
    startActiveLoopWindow(
      dependencies,
      activeTurns,
      exitTriggers,
      part,
      onActiveTurnSettled
    );

  const handleMessageWindow = (
    input: HandleMessageWindowInput
  ): Promise<AgentTurnResult | undefined> => {
    return startWindowPart(createMessageWindowPart(input));
  };

  const startTriggeredRecord = (
    record: SessionEventRecord,
    options: { minFromSeq?: number } = {}
  ): Promise<AgentTurnResult | undefined> | undefined => {
    const decision = evaluateGroupTriggers(triggers, {
      config: dependencies.config,
      sessionStore: dependencies.sessionStore,
      record,
      now: dependencies.now
    });
    if (!decision) {
      return undefined;
    }

    return handleMessageWindow({
      conversation: decision.conversation,
      fromSeq:
        options.minFromSeq !== undefined
          ? Math.max(decision.fromSeq, options.minFromSeq)
          : decision.fromSeq,
      toSeq: decision.toSeq,
      reason: decision.reason
    });
  };

  function queueActiveLoopRecord(
    record: SessionEventRecord,
    activeTurn: ActiveLoop
  ): Promise<AgentTurnResult | undefined> {
    const conversationKey = activeTurn.conversationKey;
    clearActiveLoopIdleExit(activeTurn);
    const existingBuffer = activeLoopBuffers.get(conversationKey);
    const buffer =
      existingBuffer ??
      ({
        conversation: record.event.conversation,
        records: [],
        nextDelayMs: activeLoopAggregation.delayMs
      } satisfies ActiveLoopBuffer);

    buffer.records.push(record);
    activeLoopBuffers.set(conversationKey, buffer);
    scheduleActiveLoopFlush(conversationKey, buffer);
    return activeTurn.promise;
  }

  function scheduleActiveLoopFlush(
    conversationKey: string,
    buffer: ActiveLoopBuffer
  ): void {
    if (buffer.timer) {
      return;
    }

    buffer.timer = setTimeout(() => {
      delete buffer.timer;
      flushActiveLoopBuffer(conversationKey);
    }, buffer.nextDelayMs);
  }

  function flushActiveLoopBuffer(conversationKey: string): void {
    const buffer = activeLoopBuffers.get(conversationKey);
    if (!buffer || buffer.records.length === 0) {
      return;
    }

    const activeTurn = activeTurns.get(conversationKey);
    if (!activeTurn) {
      reactivatePreTriggerFromBuffer(conversationKey, buffer);
      return;
    }

    if (!canInjectIntoActiveLoop(activeTurn, dependencies.maxSteersPerTurn)) {
      buffer.nextDelayMs = nextAggregationDelay(
        buffer.nextDelayMs,
        activeLoopAggregation
      );
      scheduleActiveLoopFlush(conversationKey, buffer);
      return;
    }

    const records = buffer.records;
    buffer.records = [];
    buffer.nextDelayMs = nextAggregationDelay(
      buffer.nextDelayMs,
      activeLoopAggregation
    );

    const firstRecord = records[0];
    const lastRecord = records.at(-1);
    if (!firstRecord || !lastRecord) {
      return;
    }

    const windowPart = dependencies.sessionStore.createMessageWindow({
      conversation: buffer.conversation,
      fromSeq: firstRecord.seq,
      toSeq: lastRecord.seq,
      closedAt: dependencies.now().toISOString(),
      reason: "steer"
    });
    void startWindowPart(windowPart);
  }

  function clearActiveLoopBuffer(conversationKey: string): void {
    const buffer = activeLoopBuffers.get(conversationKey);
    if (!buffer) {
      return;
    }
    if (buffer.timer) {
      clearTimeout(buffer.timer);
    }
    activeLoopBuffers.delete(conversationKey);
  }

  function onActiveTurnSettled(conversationKey: string): void {
    const buffer = activeLoopBuffers.get(conversationKey);
    if (!buffer) {
      return;
    }
    reactivatePreTriggerFromBuffer(conversationKey, buffer);
  }

  function reactivatePreTriggerFromBuffer(
    conversationKey: string,
    buffer: ActiveLoopBuffer
  ): void {
    if (buffer.timer) {
      clearTimeout(buffer.timer);
    }
    activeLoopBuffers.delete(conversationKey);

    const records = buffer.records;
    if (records.length === 0) {
      return;
    }

    const firstRecord = records[0];
    for (const record of records) {
      const result = startTriggeredRecord(record, {
        ...(firstRecord ? { minFromSeq: firstRecord.seq } : {})
      });
      if (result) {
        return;
      }
    }
  }

  async function handleInspectRecord(
    record: SessionEventRecord,
    command: NonNullable<ReturnType<typeof parseInspectCommand>>
  ): Promise<void> {
    await sessionRecorder.flush();
    const result = await inspectRunner.run({
      home,
      config,
      eventRecord: record,
      command,
      sessionSnapshot: dependencies.sessionStore.exportSnapshot({
        exportedAt: dependencies.now().toISOString()
      }),
      now: dependencies.now
    });

    if (result.reportText) {
      const sendResult = await sendInspectFallback(
        dependencies.connector,
        record.event,
        result.reportText
      );
      if (sendResult.ok) {
        appendSelfMessageFromInspectResult(record, result.reportText, sendResult);
      }
      await sessionRecorder.flush();
      return;
    }

    const fallbackText = `inspect 没能完成完整诊断。原因：${result.error ?? "unknown error"}`;
    const fallbackResult = await sendInspectFallback(
      dependencies.connector,
      record.event,
      fallbackText
    );
    if (fallbackResult.ok) {
      appendSelfMessageFromInspectResult(record, fallbackText, fallbackResult);
      await sessionRecorder.flush();
    }
  }

  function appendSelfMessageFromInspectResult(
    record: SessionEventRecord,
    text: string,
    sendResult: ConnectorCallResult
  ): void {
    if (record.event.type !== "MessageReceived") {
      return;
    }

    const selfId =
      readOptionalString(dependencies.config.flatValues, "bot_user_id") ??
      record.event.source.accountId ??
      "gestalt-bot";
    const selfName =
      readOptionalString(dependencies.config.flatValues, "bot_display_name") ??
      "Gestalt";
    const occurredAt = dependencies.now().toISOString();

    dependencies.sessionStore.appendEvent(
      {
        id: `self-inspect-${record.event.id}`,
        type: "MessageReceived",
        occurredAt,
        source: {
          platform: record.event.source.platform,
          connector: "runtime-inspect",
          accountId: selfId,
          rawEventId: sendResult.externalId ?? `inspect-${record.event.id}`
        },
        conversation: record.event.conversation,
        sender: {
          id: selfId,
          displayName: selfName,
          isSelf: true
        },
        message: {
          id: sendResult.externalId ?? `self-inspect-message-${record.event.id}`,
          text,
          rawText: text,
          mentionsBot: false
        },
        raw: {
          generatedBy: "inspect",
          requestEventId: record.event.id,
          requestMessageId: record.event.message.id
        }
      },
      {
        receivedAt: occurredAt
      }
    );
  }

  return {
    home,
    ingestEvent,

    async handleEvent(event) {
      const parsedEvent = CanonicalEventSchema.parse(event);
      if (!isAllowedGroupEvent(parsedEvent, allowedGroupIds)) {
        return undefined;
      }

      const record = appendParsedEvent(parsedEvent);
      const conversationKey = getConversationKey(record.event.conversation);
      if (isSlashLeaveCommand(record.event)) {
        const activeTurn = activeTurns.get(conversationKey);
        if (!activeTurn) {
          return undefined;
        }

        clearActiveLoopBuffer(conversationKey);
        forceActiveLoopExit(activeTurn, {
          decision: {
            triggerName: "slash_leave",
            reason: "slash_leave",
            description: "A /leave command force-ended the active loop."
          },
          lastSeq: record.seq
        });
        return activeTurn.promise;
      }

      const inspectCommand = parseInspectCommand(record.event);
      if (inspectCommand) {
        await handleInspectRecord(record, inspectCommand);
        return undefined;
      }

      const activeTurn = activeTurns.get(conversationKey);
      if (activeTurn) {
        if (isSelfMessageEvent(record.event)) {
          return activeTurn.promise;
        }
        return queueActiveLoopRecord(record, activeTurn);
      }
      return startTriggeredRecord(record);
    },

    handleMessageWindow,

    exportSession(options = {}) {
      return dependencies.sessionStore.exportSnapshot(options);
    },

    importSession(snapshot) {
      if (activeTurns.size > 0) {
        throw new Error("Cannot import a session while agent turns are active.");
      }
      dependencies.sessionStore.importSnapshot(snapshot);
    },

    async whenIdle() {
      while (activeTurns.size > 0) {
        await Promise.allSettled(
          Array.from(activeTurns.values()).map((turn) => turn.promise)
        );
      }
      await sessionRecorder.flush();
    }
  };
}

function isAllowedGroupEvent(
  event: CanonicalEvent,
  allowedGroupIds: Set<string> | undefined
): boolean {
  if (
    !allowedGroupIds ||
    event.type !== "MessageReceived" ||
    event.conversation.kind !== "group"
  ) {
    return true;
  }
  return allowedGroupIds.has(event.conversation.id);
}

function isSlashLeaveCommand(event: CanonicalEvent): boolean {
  return (
    event.type === "MessageReceived" &&
    !isSelfMessageEvent(event) &&
    event.message.text.trim() === "/leave"
  );
}

function readAllowedGroupIds(config: GestaltConfig): Set<string> | undefined {
  const value = config.flatValues.allowedgroups;
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error("Config value allowedgroups must be an array of group ids.");
  }
  return new Set(value.map(readAllowedGroupId));
}

function filterToolsForConfig(
  tools: ToolDefinition[],
  config: GestaltConfig
): ToolDefinition[] {
  if (readBoolean(config.flatValues, "agent_loop_exit_leave_enabled", true)) {
    return tools;
  }
  return tools.filter((tool) => tool.name !== "leave");
}

function createDreamingRunnerFromConfig(config: GestaltConfig): DreamingRunner {
  if (!readBoolean(config.flatValues, "dreaming_enabled", false)) {
    return createNoopDreamingRunner();
  }
  return createAiSdkDreamingRunner(config);
}

function readBoolean(
  flat: GestaltConfig["flatValues"],
  key: string,
  fallback: boolean
): boolean {
  const value = flat[key];
  if (typeof value === "boolean") {
    return value;
  }
  if (value === undefined) {
    return fallback;
  }
  throw new Error(`Config value ${key} must be a boolean.`);
}

function readOptionalString(
  flat: GestaltConfig["flatValues"],
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

function readAllowedGroupId(
  value: string | number | boolean,
  index: number
): string {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  throw new Error(`Config value allowedgroups[${index}] must be a group id.`);
}

function readActiveLoopAggregationConfig(
  config: GestaltConfig
): ActiveLoopAggregationConfig {
  const delayMs = readPositiveInteger(
    config.flatValues,
    "agent_loop_aggregation_delay_ms",
    10_000
  );
  const maxDelayMs = readPositiveInteger(
    config.flatValues,
    "agent_loop_aggregation_max_delay_ms",
    delayMs
  );
  const backoffMultiplier = readPositiveNumber(
    config.flatValues,
    "agent_loop_aggregation_backoff_multiplier",
    1
  );

  return {
    delayMs,
    maxDelayMs: Math.max(delayMs, maxDelayMs),
    backoffMultiplier
  };
}

function nextAggregationDelay(
  currentDelayMs: number,
  config: ActiveLoopAggregationConfig
): number {
  return Math.min(
    config.maxDelayMs,
    Math.ceil(currentDelayMs * config.backoffMultiplier)
  );
}

function readPositiveInteger(
  flat: GestaltConfig["flatValues"],
  key: string,
  fallback: number
): number {
  const value = flat[key];
  const numericValue =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : undefined;

  if (numericValue === undefined) {
    return fallback;
  }
  if (!Number.isInteger(numericValue) || numericValue <= 0) {
    throw new Error(`Config value ${key} must be a positive integer.`);
  }
  return numericValue;
}

function readPositiveNumber(
  flat: GestaltConfig["flatValues"],
  key: string,
  fallback: number
): number {
  const value = flat[key];
  const numericValue =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : undefined;

  if (numericValue === undefined) {
    return fallback;
  }
  if (!Number.isFinite(numericValue) || numericValue < 1) {
    throw new Error(`Config value ${key} must be a number greater than or equal to 1.`);
  }
  return numericValue;
}

async function sendInspectFallback(
  connector: Connector,
  event: CanonicalEvent,
  text: string
): Promise<ConnectorCallResult> {
  if (event.type !== "MessageReceived") {
    return {
      ok: false,
      error: "Inspect fallback only supports message events."
    };
  }

  if (event.conversation.kind === "group") {
    return connector.sendGroupMessage({
      groupId: event.conversation.id,
      text
    });
  }

  return connector.sendPrivateMessage({
    userId: event.conversation.id,
    text
  });
}
