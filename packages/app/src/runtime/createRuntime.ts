import { randomUUID } from "node:crypto";
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
} from "../model/session";
import { loadPersona } from "../persona/loadPersona";
import {
  createInMemorySessionStore,
  getConversationKey,
  type CreatedMessageWindow,
  type ExportSessionDiagnosticsOptions,
  type SessionStore
} from "../session/store";
import { createSessionRecorder } from "../session/recorder";
import {
  createRecentSessionEventAppender,
  createSessionHistoryReader,
  hydrateRecentSessionMessages,
  type SessionHistoryReader
} from "../session/history";
import {
  type MessageWindowReason,
  type SessionEventRecord,
  type SessionDiagnostics
} from "../session/schemas";
import {
  createRolloutReader,
  type RolloutReader
} from "../rollout";
import { createDefaultGroupTriggers } from "../triggers/defaultTriggers";
import {
  evaluateTriggerAdmission,
  validateDefaultTriggerProbabilities
} from "../triggers/admission";
import { resolveTimezone } from "../context/time";
import {
  evaluateGroupTriggers,
  type GroupTrigger
} from "../triggers/types";
import {
  type ToolImplementations
} from "../tools/executeActions";
import { createActionBashToolScope } from "../tools/agentBrowser";
import { createDefaultToolRegistry } from "../tools/registry";
import type { ToolDefinition } from "../tools/schemas";
import {
  createConfiguredStickerService,
  createStickerToolImplementations,
  isStickerSubsystemConfigured,
  readOperatorUserIds,
  readStickerRecommendationConfig,
  readStickerScrapingEnabled,
  withStickerRecommendations
} from "../stickers/integration";
import type { StickerService } from "../stickers/service";
import { type AgentTurnResult } from "./agentLoop";
import {
  canInjectIntoActiveLoop,
  clearActiveLoopIdleExit,
  forceActiveLoopExit,
  startActiveLoopWindow,
  type ActiveLoop,
  type ActiveLoopDependencies,
  type ActiveLoopToolScope
} from "./activeLoop";
import {
  createDefaultAgentLoopExitTriggers,
  type AgentLoopExitTrigger
} from "./exitTriggers";
import { commitOutboundMessage } from "./outboundMessages";

export interface Runtime {
  home: GestaltHome;
  stickers?: StickerService;
  sessionStore: SessionStore;
  sessionHistory: SessionHistoryReader;
  rolloutReader: RolloutReader;
  ingestEvent(event: unknown): Promise<SessionEventRecord>;
  dispatchEvent(event: unknown): Promise<RuntimeEventDispatch>;
  handleEvent(event: unknown): Promise<AgentTurnResult | undefined>;
  handleMessageWindow(
    input: HandleMessageWindowInput
  ): Promise<AgentTurnResult | undefined>;
  exportDiagnostics(options?: ExportSessionDiagnosticsOptions): SessionDiagnostics;
  whenIdle(): Promise<void>;
}

export interface RuntimeEventDispatch {
  /** Settles with the active-loop result; dispatch itself never waits for it. */
  outcome: Promise<AgentTurnResult | undefined>;
}

const EMPTY_RUNTIME_OUTCOME = Promise.resolve<AgentTurnResult | undefined>(
  undefined
);

function noRuntimeOutcome(): RuntimeEventDispatch {
  return { outcome: EMPTY_RUNTIME_OUTCOME };
}

export interface HandleMessageWindowInput {
  conversation: Conversation;
  eventIds: string[];
  reason?: MessageWindowReason;
}

export interface CreateRuntimeOptions {
  gestaltHome?: string;
  connector?: Connector;
  model?: ModelClient;
  tools?: ToolDefinition[];
  toolImplementations?: ToolImplementations;
  createActiveLoopToolScope?: (input: {
    activeLoopId: string;
  }) => ActiveLoopToolScope | undefined;
  dreamingRunner?: DreamingRunner;
  inspectRunner?: InspectRunner;
  maxSteersPerTurn?: number;
  triggers?: GroupTrigger[];
  exitTriggers?: AgentLoopExitTrigger[];
  liveEvents?: LiveEventSink;
  stickerService?: StickerService;
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
  validateDefaultTriggerProbabilities(config);
  const resolvedTimezone = resolveTimezone(config);
  const persona = await loadPersona(home);
  const memoryStore = createFileMemoryStore(home);
  const dreamingRunner =
    options.dreamingRunner ?? createDreamingRunnerFromConfig(config);
  const inspectRunner = options.inspectRunner ?? createAiSdkInspectRunner(config);
  const tools = options.tools ?? createDefaultToolRegistry();
  if (!tools.some((tool) => tool.name === "leave")) {
    throw new Error("The fixed agent tool protocol requires the leave tool.");
  }
  const connector = options.connector ?? createMockConnector();
  readStickerScrapingEnabled(config);
  const stickerRecommendationConfig = readStickerRecommendationConfig(config);
  const stickerService =
    options.stickerService ??
    (isStickerSubsystemConfigured(config)
      ? await createConfiguredStickerService({
          home,
          config,
          connector,
          ...(options.liveEvents ? { liveEvents: options.liveEvents } : {}),
          now
        })
      : undefined);
  const operatorUserIds = readOperatorUserIds(config);
  const stickerToolImplementations = stickerService
    ? createStickerToolImplementations(stickerService)
    : {};
  const baseToolImplementations = {
    ...stickerToolImplementations,
    ...(options.toolImplementations ?? {})
  };
  const toolImplementations = stickerService
    ? withStickerRecommendations({
        service: stickerService,
        config: stickerRecommendationConfig,
        implementations: baseToolImplementations
      })
    : baseToolImplementations;
  const model = options.model ?? createMockModel({ now });
  const sessionRecorder = createSessionRecorder(home);
  const sessionStore = createInMemorySessionStore({
    now,
    onJournalRecord: (record) => sessionRecorder.enqueue(record),
    onEventAppended(record) {
      options.liveEvents?.publish(
        "session.event.appended",
        {
          conversationKey: getConversationKey(record.event.conversation),
          eventId: record.event.id,
          recordId: record.id
        },
        record.receivedAt
      );
    },
    onWindowCreated(window) {
      options.liveEvents?.publish(
        "session.window.created",
        {
          conversationKey: getConversationKey(window.conversation),
          windowId: window.id
        },
        window.closedAt
      );
    },
    onTriggerAttemptRecorded(attempt) {
      options.liveEvents?.publish(
        "session.trigger_attempt.recorded",
        {
          conversationKey: getConversationKey(attempt.conversation),
          attemptId: attempt.id
        },
        attempt.evaluatedAt
      );
    },
    onTurnRecorded(turn) {
      options.liveEvents?.publish(
        "session.turn.recorded",
        {
          conversationKey: getConversationKey(turn.conversation),
          turnId: turn.id,
          rolloutId: turn.rolloutId
        },
        turn.endedAt
      );
    },
    onLoopExitRecorded(exit) {
      options.liveEvents?.publish(
        "session.loop_exit.recorded",
        {
          conversationKey: getConversationKey(exit.conversation),
          exitId: exit.id
        },
        exit.endedAt
      );
    }
  });
  const sessionHistory = createSessionHistoryReader(home);
  const rolloutReader = createRolloutReader({ tracesDir: home.tracesDir });
  await hydrateRecentSessionMessages({
    home,
    config,
    store: sessionStore,
    reader: sessionHistory,
    now
  });
  const sessionEventAppender = createRecentSessionEventAppender({
    config,
    store: sessionStore,
    reader: sessionHistory,
    now
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
    now,
    resolvedTimezone,
    sessionStore,
    async commitOutboundMessage({ sourceEvent, proposal, result }) {
      await commitOutboundMessage({
        config,
        sourceEvent,
        proposal,
        result,
        appendEvent: (event, appendOptions) =>
          sessionEventAppender.appendEvent(event, appendOptions),
        flushDurable: () => sessionRecorder.flush({ durable: true })
      });
    },
    maxSteersPerTurn: options.maxSteersPerTurn ?? 2,
    ...(options.liveEvents ? { liveEvents: options.liveEvents } : {}),
    toolImplementations,
    createActiveLoopToolScope({ activeLoopId }) {
      if (options.createActiveLoopToolScope) {
        return options.createActiveLoopToolScope({ activeLoopId });
      }
      if (
        !tools.some((tool) => tool.name === "bash") ||
        toolImplementations.bash
      ) {
        return undefined;
      }
      const bashScope = createActionBashToolScope({
        namespace: "gestalt",
        sessionId: `gestalt-${activeLoopId}`
      });
      return {
        toolImplementations: {
          ...toolImplementations,
          bash: bashScope.implementation
        },
        async dispose() {
          await bashScope.dispose();
        }
      };
    }
  };

  const appendParsedEvent = (
    parsedEvent: CanonicalEvent
  ): Promise<SessionEventRecord> => {
    return sessionEventAppender.appendEvent(parsedEvent, {
      receivedAt: dependencies.now().toISOString()
    });
  };

  const ingestEvent = (event: unknown): Promise<SessionEventRecord> => {
    return appendParsedEvent(CanonicalEventSchema.parse(event));
  };

  const createMessageWindowPart = (
    input: HandleMessageWindowInput
  ): Promise<CreatedMessageWindow> =>
    dependencies.sessionStore.createMessageWindow({
      conversation: input.conversation,
      eventIds: input.eventIds,
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

  const handleMessageWindow = async (
    input: HandleMessageWindowInput
  ): Promise<AgentTurnResult | undefined> => {
    return startWindowPart(await createMessageWindowPart(input));
  };

  const startTriggeredRecord = async (
    record: SessionEventRecord,
    options: { allowedEventIds?: ReadonlySet<string> } = {}
  ): Promise<
    | { promise: Promise<AgentTurnResult | undefined> }
    | undefined
  > => {
    const decision = evaluateGroupTriggers(triggers, {
      config: dependencies.config,
      sessionStore: dependencies.sessionStore,
      record,
      now: dependencies.now
    });
    if (!decision) {
      return undefined;
    }

    const admission = evaluateTriggerAdmission(
      dependencies.config,
      record,
      decision
    );
    const eventIds = options.allowedEventIds
      ? decision.eventIds.filter((eventId) =>
          options.allowedEventIds?.has(eventId)
        )
      : decision.eventIds;
    if (eventIds.length === 0) {
      return undefined;
    }
    await dependencies.sessionStore.recordTriggerAttempt({
      id: randomUUID(),
      conversation: decision.conversation,
      triggerName: decision.triggerName,
      reason: decision.reason,
      eventId: record.event.id,
      eventIds,
      probability: admission.probability,
      sample: admission.sample,
      admitted: admission.admitted,
      evaluatedAt: dependencies.now().toISOString()
    });
    if (!admission.admitted) {
      return undefined;
    }

    const part = await createMessageWindowPart({
      conversation: decision.conversation,
      eventIds,
      reason: decision.reason
    });
    return { promise: startWindowPart(part) };
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
      void flushActiveLoopBuffer(conversationKey).catch((error: unknown) => {
        publishBackgroundFailure("active_loop_buffer_flush_failed", error);
      });
    }, buffer.nextDelayMs);
  }

  async function flushActiveLoopBuffer(conversationKey: string): Promise<void> {
    const buffer = activeLoopBuffers.get(conversationKey);
    if (!buffer || buffer.records.length === 0) {
      return;
    }

    const activeTurn = activeTurns.get(conversationKey);
    if (!activeTurn) {
      await reactivatePreTriggerFromBuffer(conversationKey, buffer);
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

    const windowPart = await dependencies.sessionStore.createMessageWindow({
      conversation: buffer.conversation,
      eventIds: records.map((record) => record.event.id),
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
    void reactivatePreTriggerFromBuffer(conversationKey, buffer).catch(
      (error: unknown) => {
        publishBackgroundFailure("buffer_reactivation_failed", error);
      }
    );
  }

  async function reactivatePreTriggerFromBuffer(
    conversationKey: string,
    buffer: ActiveLoopBuffer
  ): Promise<void> {
    if (buffer.timer) {
      clearTimeout(buffer.timer);
    }
    activeLoopBuffers.delete(conversationKey);

    const records = buffer.records;
    if (records.length === 0) {
      return;
    }

    const allowedEventIds = new Set(
      records.map((record) => record.event.id)
    );
    for (const record of records) {
      const result = await startTriggeredRecord(record, {
        allowedEventIds
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
      sessionDiagnostics: dependencies.sessionStore.exportDiagnostics({
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
        await appendSelfMessageFromInspectResult(
          record,
          result.reportText,
          sendResult
        );
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
      await appendSelfMessageFromInspectResult(
        record,
        fallbackText,
        fallbackResult
      );
      await sessionRecorder.flush();
    }
  }

  async function appendSelfMessageFromInspectResult(
    record: SessionEventRecord,
    text: string,
    sendResult: ConnectorCallResult
  ): Promise<void> {
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

    await dependencies.sessionStore.appendEvent(
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
    ...(stickerService ? { stickers: stickerService } : {}),
    sessionStore,
    sessionHistory,
    rolloutReader,
    ingestEvent,
    dispatchEvent,

    async handleEvent(event) {
      return (await dispatchEvent(event)).outcome;
    },

    handleMessageWindow,

    exportDiagnostics(options = {}) {
      return dependencies.sessionStore.exportDiagnostics(options);
    },

    async whenIdle() {
      while (activeTurns.size > 0) {
        await Promise.allSettled(
          Array.from(activeTurns.values()).map((turn) => turn.promise)
        );
      }
      await sessionRecorder.flush({ durable: true });
      await stickerService?.whenIdle();
    }
  };

  async function dispatchEvent(event: unknown): Promise<RuntimeEventDispatch> {
    const parsedEvent = CanonicalEventSchema.parse(event);
    if (!isAllowedGroupEvent(parsedEvent, allowedGroupIds)) {
      return noRuntimeOutcome();
    }

    dependencies.sessionStore.pinConversation(parsedEvent.conversation);
    try {
      const record = await appendParsedEvent(parsedEvent);
      const conversationKey = getConversationKey(record.event.conversation);
      const scrapeCommand = parseScrapeStickerCommand(record.event);
      if (scrapeCommand) {
        const authorized = operatorUserIds.has(record.event.sender.id);
        let reply: string;
        if (!authorized) {
          reply = "无权执行该命令";
        } else if (!stickerService) {
          reply = "表情系统未配置 embedding_model_*";
        } else if (scrapeCommand.mode === "invalid") {
          reply = "用法：/scrape-sticker [on|off]";
        } else {
          const context = {
            actorUserId: record.event.sender.id,
            sourceEventId: record.event.id,
            at: dependencies.now().toISOString()
          };
          const enabled =
            scrapeCommand.mode === "toggle"
              ? await stickerService.toggleScraping(context)
              : await stickerService.setScrapingOverride(
                  scrapeCommand.mode === "on",
                  context
                );
          reply = enabled ? "表情采集已开启" : "表情采集已关闭";
        }
        const sendResult = await sendRuntimeControlReply(
          dependencies.connector,
          record.event,
          reply
        );
        if (sendResult.ok) {
          await appendRuntimeControlReply(record, reply, sendResult);
          await sessionRecorder.flush();
        }
        return noRuntimeOutcome();
      }

      if (isSlashLeaveCommand(record.event)) {
        const activeTurn = activeTurns.get(conversationKey);
        if (!activeTurn) {
          return noRuntimeOutcome();
        }

        clearActiveLoopBuffer(conversationKey);
        forceActiveLoopExit(activeTurn, {
          decision: {
            triggerName: "slash_leave",
            reason: "slash_leave",
            description: "A /leave command force-ended the active loop."
          },
          lastEventId: record.event.id
        });
        return { outcome: activeTurn.promise };
      }

      const inspectCommand = parseInspectCommand(record.event);
      if (inspectCommand) {
        await handleInspectRecord(record, inspectCommand);
        return noRuntimeOutcome();
      }

      if (stickerService && parsedEvent.type === "MessageReceived") {
        try {
          // Session storage intentionally retains only its sanitized journal
          // representation. Sticker extraction gets the transient connector
          // event so source segments are usable without pinning transport media
          // in the bounded SessionStore.
          await stickerService.observe(parsedEvent);
        } catch (error) {
          try {
            options.liveEvents?.publish("sticker.job.updated", {
              sourceEventId: parsedEvent.id,
              error: error instanceof Error ? error.message : String(error)
            });
          } catch {
            // Sticker Live events are diagnostics and must not interrupt
            // ordinary message ingestion when their sink is unavailable.
          }
        }
      }

      const activeTurn = activeTurns.get(conversationKey);
      if (activeTurn) {
        if (isSelfMessageEvent(record.event)) {
          return { outcome: activeTurn.promise };
        }
        return { outcome: queueActiveLoopRecord(record, activeTurn) };
      }
      const started = await startTriggeredRecord(record);
      return started ? { outcome: started.promise } : noRuntimeOutcome();
    } finally {
      dependencies.sessionStore.unpinConversation(parsedEvent.conversation);
    }
  }

  async function appendRuntimeControlReply(
    record: SessionEventRecord,
    text: string,
    sendResult: ConnectorCallResult
  ): Promise<void> {
    const selfId =
      readOptionalString(dependencies.config.flatValues, "bot_user_id") ??
      record.event.source.accountId ??
      "gestalt-bot";
    const selfName =
      readOptionalString(dependencies.config.flatValues, "bot_display_name") ??
      "Gestalt";
    const occurredAt = dependencies.now().toISOString();
    await dependencies.sessionStore.appendEvent(
      {
        id: `self-control-${record.event.id}`,
        type: "MessageReceived",
        occurredAt,
        source: {
          platform: record.event.source.platform,
          connector: "runtime-control",
          accountId: selfId,
          rawEventId: sendResult.externalId ?? `control-${record.event.id}`
        },
        conversation: record.event.conversation,
        sender: { id: selfId, displayName: selfName, isSelf: true },
        message: {
          id: sendResult.externalId ?? `self-control-message-${record.event.id}`,
          text,
          rawText: text,
          mentionsBot: false
        },
        raw: {
          generatedBy: "runtime-control",
          requestEventId: record.event.id
        }
      },
      { receivedAt: occurredAt }
    );
  }

  function publishBackgroundFailure(code: string, error: unknown): void {
    options.liveEvents?.publish("agent.run.failed", {
      entity: { kind: "signal", id: code },
      status: "failed",
      summary: error instanceof Error ? error.message : String(error)
    });
  }
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

type ScrapeStickerCommand = {
  mode: "on" | "off" | "toggle" | "invalid";
};

function parseScrapeStickerCommand(
  event: CanonicalEvent
): ScrapeStickerCommand | undefined {
  if (event.type !== "MessageReceived" || isSelfMessageEvent(event)) {
    return undefined;
  }
  const parts = event.message.text.trim().split(/\s+/);
  if (parts[0] !== "/scrape-sticker") {
    return undefined;
  }
  if (parts.length === 1) {
    return { mode: "toggle" };
  }
  if (parts.length === 2 && (parts[1] === "on" || parts[1] === "off")) {
    return { mode: parts[1] };
  }
  return { mode: "invalid" };
}

async function sendRuntimeControlReply(
  connector: Connector,
  event: CanonicalEvent,
  text: string
): Promise<ConnectorCallResult> {
  if (event.conversation.kind === "group") {
    return connector.sendGroupMessage({ groupId: event.conversation.id, text });
  }
  return connector.sendPrivateMessage({ userId: event.conversation.id, text });
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
