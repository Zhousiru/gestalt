import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ConversationTimelinePageSchema,
  ConversationsPageSchema,
  LiveEventEnvelopeSchema,
  LiveOverviewSchema,
  MAX_PAGE_LIMIT,
  DEFAULT_PAGE_LIMIT,
  ModelInputResponseSchema,
  ModelInputViewSchema,
  RolloutDetailSchema,
  RolloutsPageSchema,
  RolloutStatusSchema,
  type CacheUsage,
  type ConversationSummary,
  type ConversationTimelineItem,
  type FlowItem,
  type GenerationSummary,
  type LiveEventEnvelope,
  type LiveOverview,
  type LiveSignal,
  type ModelInputResponse,
  type RolloutDetail as WireRolloutDetail,
  type RolloutRecordView,
  type RolloutStatus,
  type RolloutSummary as WireRolloutSummary,
  type SignalCounts,
  type TokenUsage
} from "@gestalt/live-contracts";
import type { Conversation } from "../events/schemas";
import { loadConfig } from "../home/loadConfig";
import { sanitizeUntrustedValue } from "../privacy/stickerRedaction";
import {
  createRolloutReader,
  resolveTraceBinaryCaptureEnabled,
  traceBlobPath,
  type ReconstructedInput,
  type RolloutDetail,
  type RolloutMessage,
  type RolloutReader,
  type RolloutRecord,
  type RolloutSummary
} from "../rollout";
import type { Runtime } from "../runtime/createRuntime";
import { readSessionRecentHistoryHours } from "../session/config";
import { getConversationKey } from "../session/store";
import type {
  ConversationSessionState,
  SessionEventRecord,
  SessionTurnRecord
} from "../session/schemas";
import {
  normalizeStickerCatalogQuery,
  type StickerCatalogQuery
} from "../stickers/service";
import type { LiveEventBus } from "./eventBus";
import type { LiveRunStore } from "./runStore";
import type { ActiveRunView, RuntimeLiveEventEnvelope } from "./viewTypes";

export interface StartLiveDebugServerOptions {
  runtime: Runtime;
  bus: LiveEventBus;
  runStore: LiveRunStore;
  rolloutReader?: RolloutReader;
  binaryCaptureEnabled?: boolean;
  sessionRecentHistoryHours?: number;
  host?: string;
  port?: number;
  uiDir?: string;
  now?: () => Date;
}

export interface LiveDebugServer {
  url: string;
  close(): Promise<void>;
}

interface ResolvedLiveDebugServerOptions {
  runtime: Runtime;
  bus: LiveEventBus;
  runStore: LiveRunStore;
  rolloutReader: RolloutReader;
  binaryCaptureEnabled: boolean;
  sessionRecentHistoryHours: number;
  host: string;
  port: number;
  uiDir?: string;
  now: () => Date;
  sseResponses: Set<ServerResponse>;
}

interface RolloutPageCursor {
  phase: "active" | "storage";
  activeOffset?: number;
  storageCursor?: string;
}

interface ConversationPageCursor {
  lastAt: string;
  key: string;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const EMPTY_SIGNALS: SignalCounts = { info: 0, warning: 0, error: 0 };

export async function startLiveDebugServer(
  options: StartLiveDebugServerOptions
): Promise<LiveDebugServer> {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const now = options.now ?? (() => new Date());
  const uiDir = options.uiDir ? path.resolve(options.uiDir) : undefined;
  const config = await loadConfig(options.runtime.home);
  const binaryCaptureEnabled =
    options.binaryCaptureEnabled ?? resolveTraceBinaryCaptureEnabled(config);
  const sessionRecentHistoryHours =
    options.sessionRecentHistoryHours ?? readSessionRecentHistoryHours(config);
  if (
    !Number.isFinite(sessionRecentHistoryHours) ||
    sessionRecentHistoryHours <= 0
  ) {
    throw new Error("sessionRecentHistoryHours must be positive.");
  }
  const rolloutReader =
    options.rolloutReader ??
    options.runtime.rolloutReader ??
    createRolloutReader({ tracesDir: options.runtime.home.tracesDir });
  const sseResponses = new Set<ServerResponse>();
  const resolved: ResolvedLiveDebugServerOptions = {
    runtime: options.runtime,
    bus: options.bus,
    runStore: options.runStore,
    rolloutReader,
    binaryCaptureEnabled,
    sessionRecentHistoryHours,
    host,
    port,
    now,
    sseResponses,
    ...(uiDir ? { uiDir } : {})
  };

  const server = http.createServer((request, response) => {
    void handleRequest(request, response, resolved).catch((error) => {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      const status = error instanceof HttpError ? error.status : 500;
      sendJson(response, status, {
        error:
          error instanceof HttpError
            ? error.message
            : "The Live API could not complete this request."
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
  const address = server.address();
  const listeningPort =
    address && typeof address === "object" ? address.port : port;

  return {
    url: `http://${host}:${listeningPort}`,
    close() {
      for (const response of sseResponses) {
        response.end();
      }
      return new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: ResolvedLiveDebugServerOptions
): Promise<void> {
  if (request.method !== "GET") {
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }
  if (!isAllowedRequest(request)) {
    sendJson(response, 403, {
      error: "Live debug server rejected the request origin"
    });
    return;
  }

  const url = new URL(
    request.url ?? "/",
    `http://${request.headers.host ?? "localhost"}`
  );
  const pathname = url.pathname;

  if (pathname === "/api/live/health") {
    sendJson(response, 200, {
      ok: true,
      at: options.now().toISOString(),
      home: options.runtime.home.root
    });
    return;
  }

  if (pathname === "/api/live/overview") {
    const overview = LiveOverviewSchema.parse(await createOverview(options));
    sendJson(response, 200, overview);
    return;
  }

  if (pathname === "/api/live/conversations") {
    const page = ConversationsPageSchema.parse(
      await listConversations(options, url)
    );
    sendJson(response, 200, page);
    return;
  }

  const timelineMatch = pathname.match(
    /^\/api\/live\/conversations\/([^/]+)\/timeline$/
  );
  if (timelineMatch?.[1]) {
    const conversationKey = decodePathSegment(timelineMatch[1]);
    const page = ConversationTimelinePageSchema.parse(
      await readConversationTimeline(options, conversationKey, url)
    );
    sendJson(response, 200, page);
    return;
  }

  if (pathname === "/api/live/rollouts") {
    const page = RolloutsPageSchema.parse(await listRollouts(options, url));
    sendJson(response, 200, page);
    return;
  }

  const modelInputMatch = pathname.match(
    /^\/api\/live\/rollouts\/([^/]+)\/model-input$/
  );
  if (modelInputMatch?.[1]) {
    const rolloutId = decodePathSegment(modelInputMatch[1]);
    const modelInput = ModelInputResponseSchema.parse(
      await readModelInput(options, rolloutId, url)
    );
    sendJson(response, 200, modelInput);
    return;
  }

  const rolloutMatch = pathname.match(/^\/api\/live\/rollouts\/([^/]+)$/);
  if (rolloutMatch?.[1]) {
    const rolloutId = decodePathSegment(rolloutMatch[1]);
    const detail = RolloutDetailSchema.parse(
      await readRolloutDetail(options, rolloutId)
    );
    sendJson(response, 200, detail);
    return;
  }

  const blobMatch = pathname.match(/^\/api\/live\/blobs\/([^/]+)$/);
  if (blobMatch?.[1]) {
    await serveTraceBlob(response, options, decodePathSegment(blobMatch[1]));
    return;
  }

  if (pathname === "/api/live/stickers/snapshot") {
    const catalogQuery = parseStickerCatalogQuery(url);
    if (!options.runtime.stickers) {
      sendJson(
        response,
        200,
        emptyStickerSnapshot(options.now().toISOString(), catalogQuery)
      );
      return;
    }
    sendJson(
      response,
      200,
      await options.runtime.stickers.snapshot(catalogQuery)
    );
    return;
  }

  const stickerAssetMatch = pathname.match(
    /^\/api\/live\/stickers\/assets\/([^/]+)\/(original|contact-sheet)$/
  );
  if (stickerAssetMatch?.[1] && stickerAssetMatch[2]) {
    if (!options.runtime.stickers) {
      sendJson(response, 404, { error: "Sticker subsystem is not configured" });
      return;
    }
    const filePath = await options.runtime.stickers.resolveAssetPath(
      decodePathSegment(stickerAssetMatch[1]),
      stickerAssetMatch[2] === "contact-sheet" ? "contact-sheet" : "original"
    );
    if (!filePath || !(await fileIfExists(filePath))) {
      sendJson(response, 404, { error: "Sticker asset not found" });
      return;
    }
    if (!isSupportedStickerAsset(filePath)) {
      sendJson(response, 415, { error: "Unsupported sticker asset type" });
      return;
    }
    await serveFile(response, filePath, { untrustedImage: true });
    return;
  }

  if (pathname === "/api/live/events") {
    serveSse(request, response, options.bus, options.now, options.sseResponses);
    return;
  }

  if (pathname.startsWith("/api/")) {
    sendJson(response, 404, { error: "API route not found" });
    return;
  }

  if (options.uiDir) {
    await serveStatic(response, options.uiDir, pathname);
    return;
  }

  sendJson(response, 404, {
    error: "Not found",
    hint: "Live UI assets are missing from the application distribution."
  });
}

async function createOverview(
  options: ResolvedLiveDebugServerOptions
): Promise<LiveOverview> {
  const states = options.runtime.sessionStore.listConversationStates();
  const activeRuns = runningRuns(options.runStore, options.now);
  let recentRollouts: RolloutSummary[] = [];
  let storedRolloutIds = new Set<string>();
  let rolloutsCapped = false;
  const signals: LiveSignal[] = [];
  try {
    const catalog = await options.rolloutReader.list({ limit: MAX_PAGE_LIMIT });
    storedRolloutIds = new Set(catalog.items.map((summary) => summary.id));
    rolloutsCapped = Boolean(catalog.nextCursor);
    recentRollouts = catalog.items.slice(0, 20);
    for (const summary of recentRollouts) {
      if (
        summary.status === "failed" &&
        !activeRuns.some((run) => run.traceId === summary.id)
      ) {
        signals.push({
          id: `rollout:${summary.id}:failed`,
          severity: "error",
          code: summary.failureReason ?? "rollout_failed",
          title: "Rollout failed",
          message:
            summary.failureReason === "process_restarted"
              ? "The process restarted before this rollout wrote its terminal record."
              : summary.failureReason ?? "The rollout ended with a failure.",
          at: summary.endedAt ?? summary.startedAt,
          ...(summary.conversationKey
            ? { conversationKey: summary.conversationKey }
            : {}),
          rolloutId: summary.id
        });
      }
      if (summary.unresolvedOutboundActionCount > 0) {
        signals.push({
          id: `rollout:${summary.id}:unknown-outbound`,
          severity: "warning",
          code: "outbound_result_unknown",
          title: "Outbound result unknown",
          message: `${summary.unresolvedOutboundActionCount} outbound action result(s) are unknown and were not retried.`,
          at: summary.endedAt ?? summary.startedAt,
          ...(summary.conversationKey
            ? { conversationKey: summary.conversationKey }
            : {}),
          rolloutId: summary.id
        });
      }
    }
  } catch {
    signals.push({
      id: "rollouts:read-failed",
      severity: "error",
      code: "rollout_catalog_unavailable",
      title: "Rollout catalog unavailable",
      message: "Recent rollout summaries could not be read. Retry this panel."
    });
  }

  const latestActivityAt = latestTimestamp([
    ...states.flatMap((state) => state.events.map((event) => event.receivedAt)),
    ...recentRollouts.flatMap((summary) => [
      summary.startedAt,
      ...(summary.endedAt ? [summary.endedAt] : [])
    ]),
    ...activeRuns.map((run) => run.updatedAt)
  ]);

  return {
    generatedAt: options.now().toISOString(),
    counts: {
      conversations: states.length,
      rollouts: new Set([
        ...activeRuns.map((run) => run.traceId),
        ...storedRolloutIds
      ]).size,
      rolloutsCapped,
      activeRollouts: activeRuns.length,
      signals: signals.length
    },
    binaryCaptureEnabled: options.binaryCaptureEnabled,
    ...(latestActivityAt ? { latestActivityAt } : {}),
    signals
  };
}

async function listConversations(
  options: ResolvedLiveDebugServerOptions,
  url: URL
): Promise<{ items: ConversationSummary[]; nextCursor?: string }> {
  const limit = parsePageLimit(url);
  const query = (url.searchParams.get("query") ?? "").trim().toLowerCase();
  const cursor = url.searchParams.has("cursor")
    ? decodeConversationCursor(url.searchParams.get("cursor") ?? "")
    : undefined;
  const states = new Map(
    options.runtime.sessionStore
      .listConversationStates()
      .map((state) => [getConversationKey(state.conversation), state] as const)
  );
  const since = new Date(
    options.now().valueOf() -
      options.sessionRecentHistoryHours * 60 * 60 * 1_000
  );
  const seen = new Set<string>();
  const items: ConversationSummary[] = [];
  let historyCursor: string | undefined;

  while (items.length <= limit) {
    const page = await options.runtime.sessionHistory.searchMessages(
      "",
      {},
      { since, until: options.now() },
      historyCursor,
      MAX_PAGE_LIMIT
    );
    for (const record of page.items) {
      const key = getConversationKey(record.event.conversation);
      if (seen.has(key)) {
        continue;
      }
      if (!historyConversationMatches(record, query)) {
        continue;
      }
      // Mark the first (newest matching) occurrence even when it is before the
      // page boundary, otherwise an older match could duplicate the
      // conversation on a later page.
      seen.add(key);
      const cached = states.get(key);
      const summary = cached && cached.events.at(-1)?.id === record.id
        ? toConversationSummary(cached)
        : toHistoryConversationSummary(record);
      if (cursor && !isConversationAfterCursor(summary, cursor)) {
        continue;
      }
      items.push(summary);
      if (items.length > limit) {
        break;
      }
    }
    if (items.length > limit || !page.nextCursor) {
      break;
    }
    historyCursor = page.nextCursor;
  }

  const pageItems = items.slice(0, limit);
  const last = pageItems.at(-1);
  return {
    items: pageItems,
    ...(items.length > limit && last
      ? {
          nextCursor: encodeCursor({
            lastAt: last.lastAt ?? "",
            key: last.key
          })
        }
      : {})
  };
}

async function readConversationTimeline(
  options: ResolvedLiveDebugServerOptions,
  conversationKey: string,
  url: URL
): Promise<{
  conversation: ConversationSummary;
  items: ConversationTimelineItem[];
  nextCursor?: string;
}> {
  const conversation = parseConversationKey(conversationKey);
  const limit = parsePageLimit(url);
  const cursor = readOptionalQuery(url, "cursor");
  const state = options.runtime.sessionStore.getConversationState(conversation);
  const rolloutMarkers = cursor
    ? []
    : recentRolloutMarkers(
        state,
        runningRuns(options.runStore, options.now),
        conversationKey,
        Math.min(10, Math.max(0, limit - 1))
      );
  const messageLimit = Math.max(1, limit - rolloutMarkers.length);
  const since = new Date(
    options.now().valueOf() -
      options.sessionRecentHistoryHours * 60 * 60 * 1_000
  );
  let page;
  try {
    page = await options.runtime.sessionHistory.searchMessages(
      "",
      { conversation },
      { since, until: options.now() },
      cursor,
      messageLimit
    );
  } catch (error) {
    if (isInvalidInputError(error)) {
      throw new HttpError(400, "Invalid timeline cursor.");
    }
    throw error;
  }
  const messageItems = page.items.map(toTimelineMessage);
  const items = [...messageItems, ...rolloutMarkers].sort(compareTimelineItems);
  const effectiveState =
    state ?? stateFromTimeline(conversation, page.items, rolloutMarkers);
  return {
    conversation: toConversationSummary(effectiveState),
    items,
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {})
  };
}

async function listRollouts(
  options: ResolvedLiveDebugServerOptions,
  url: URL
): Promise<{ items: WireRolloutSummary[]; nextCursor?: string }> {
  const limit = parsePageLimit(url);
  const query = (url.searchParams.get("query") ?? "").trim();
  const statusValue = readOptionalQuery(url, "status");
  const parsedStatus = statusValue
    ? RolloutStatusSchema.safeParse(statusValue)
    : undefined;
  if (parsedStatus && !parsedStatus.success) {
    throw new HttpError(400, "Invalid rollout status.");
  }
  const status = parsedStatus?.success ? parsedStatus.data : undefined;
  const cursorValue = readOptionalQuery(url, "cursor");
  const cursor = cursorValue ? decodeRolloutCursor(cursorValue) : undefined;
  const activeRuns = runningRuns(options.runStore, options.now);
  const activeItems = activeRuns
    .map((run) => toActiveRolloutSummary(run))
    .filter((summary) => rolloutMatches(summary, query, status))
    .sort(compareWireRollouts);
  const activeIds = new Set(activeRuns.map((run) => run.traceId));
  const items: WireRolloutSummary[] = [];
  let storageCursor = cursor?.storageCursor;

  if (!cursor || cursor.phase === "active") {
    const activeOffset = cursor?.activeOffset ?? 0;
    items.push(...activeItems.slice(activeOffset, activeOffset + limit));
    if (activeOffset + items.length < activeItems.length) {
      return {
        items,
        nextCursor: encodeCursor({
          phase: "active",
          activeOffset: activeOffset + items.length
        } satisfies RolloutPageCursor)
      };
    }
  }

  if (status !== "running") {
    let hasMoreStorage = true;
    while (items.length < limit && hasMoreStorage) {
      const remaining = limit - items.length;
      let page;
      try {
        page = await options.rolloutReader.list({
          limit: remaining,
          ...(storageCursor ? { cursor: storageCursor } : {}),
          ...(query ? { query } : {}),
          ...(status ? { status } : {})
        });
      } catch (error) {
        if (isInvalidInputError(error)) {
          throw new HttpError(400, "Invalid rollout cursor.");
        }
        throw error;
      }
      storageCursor = page.nextCursor;
      for (const summary of page.items) {
        if (activeIds.has(summary.id)) {
          continue;
        }
        items.push(toWireRolloutSummary(summary));
      }
      hasMoreStorage = Boolean(page.nextCursor);
      if (page.items.length === 0) {
        break;
      }
    }
  }

  return {
    items,
    ...(storageCursor
      ? {
          nextCursor: encodeCursor({
            phase: "storage",
            storageCursor
          } satisfies RolloutPageCursor)
        }
      : {})
  };
}

async function readRolloutDetail(
  options: ResolvedLiveDebugServerOptions,
  rolloutId: string
): Promise<WireRolloutDetail> {
  let detail: RolloutDetail;
  try {
    detail = await options.rolloutReader.read(rolloutId);
  } catch (error) {
    if (isNotFoundError(error)) {
      throw new HttpError(404, "Rollout not found.");
    }
    throw error;
  }
  const activeRun = runningRuns(options.runStore, options.now).find(
    (run) => run.traceId === rolloutId
  );
  const initialized = detail.records.find(
    (record) => record.type === "model_session_initialized"
  );
  const generations = detail.records
    .filter(
      (record): record is Extract<RolloutRecord, { type: "generation_completed" }> =>
        record.type === "generation_completed"
    )
    .map(toGenerationSummary);
  const signals = createRolloutSignals(detail, Boolean(activeRun));
  const records = detail.records.map(toRecordView);
  return {
    summary: activeRun
      ? toActiveRolloutSummary(activeRun, detail.summary)
      : toWireRolloutSummary(detail.summary),
    modelSession: {
      ...(initialized ? { initializedAt: initialized.timestamp } : {}),
      ...(initialized ? { initialStateHash: initialized.stateHash } : {}),
      initialMessageCount: initialized?.messages.length ?? 0,
      toolCount: initialized?.tools.length ?? 0,
      toolNames: initialized ? initialized.tools.flatMap(readToolName) : []
    },
    generations,
    flow: createFlow(detail.records),
    records,
    signals
  };
}

async function readModelInput(
  options: ResolvedLiveDebugServerOptions,
  rolloutId: string,
  url: URL
): Promise<ModelInputResponse> {
  const generationId = readOptionalQuery(url, "generationId");
  if (!generationId) {
    throw new HttpError(400, "generationId is required.");
  }
  const viewResult = ModelInputViewSchema.safeParse(
    url.searchParams.get("view") ?? "delta"
  );
  if (!viewResult.success) {
    throw new HttpError(400, "view must be delta or full.");
  }

  let detail: RolloutDetail;
  let full: ReconstructedInput;
  try {
    [detail, full] = await Promise.all([
      options.rolloutReader.read(rolloutId),
      options.rolloutReader.reconstructInput(rolloutId, generationId)
    ]);
  } catch (error) {
    if (isNotFoundError(error)) {
      throw new HttpError(404, "Rollout or generation not found.");
    }
    throw error;
  }
  const generationIds = detail.records.flatMap((record) =>
    record.type === "generation_completed" ? [record.generationId] : []
  );
  const generationIndex = generationIds.indexOf(generationId);
  if (generationIndex < 0) {
    throw new HttpError(404, "Generation not found.");
  }
  const previousId = generationIds[generationIndex - 1];
  const previous =
    viewResult.data === "delta" && previousId
      ? await options.rolloutReader.reconstructInput(rolloutId, previousId)
      : undefined;
  const messages =
    viewResult.data === "full"
      ? full.messages
      : full.messages.slice(commonMessagePrefix(previous?.messages ?? [], full.messages));
  const committedAt = committedMessageTimes(detail.records);
  const wireMessages = messages.map((message) =>
    toModelMessage(message, committedAt.get(message.id))
  );
  const includeTools = viewResult.data === "full" || generationIndex === 0;
  return {
    rolloutId,
    generationId,
    view: viewResult.data,
    stateHash: full.stateHash,
    messageCount: full.messageCount,
    messages: wireMessages,
    ...(includeTools ? { tools: full.tools } : {}),
    unavailableBinaryCount:
      countUnavailableBinary(wireMessages) +
      (includeTools ? countUnavailableBinary(full.tools) : 0)
  };
}

function toConversationSummary(
  state: ConversationSessionState
): ConversationSummary {
  const last = state.events.at(-1);
  const failedTurns = state.turns.filter((turn) => turn.status === "failed").length;
  const cancelledTurns = state.turns.filter(
    (turn) => turn.status === "cancelled"
  ).length;
  return {
    key: getConversationKey(state.conversation),
    kind: state.conversation.kind,
    id: state.conversation.id,
    ...(state.conversation.name ? { name: state.conversation.name } : {}),
    ...(last ? { lastAt: last.receivedAt } : {}),
    ...(last ? { lastText: last.event.message.text } : {}),
    messageCount: state.events.length,
    rolloutCount: state.turns.length,
    signals: {
      info: 0,
      warning: cancelledTurns,
      error: failedTurns
    }
  };
}

function toHistoryConversationSummary(
  record: SessionEventRecord
): ConversationSummary {
  const conversation = record.event.conversation;
  return {
    key: getConversationKey(conversation),
    kind: conversation.kind,
    id: conversation.id,
    ...(conversation.name ? { name: conversation.name } : {}),
    lastAt: record.receivedAt,
    lastText: record.event.message.text,
    messageCount: 1,
    rolloutCount: 0,
    signals: { ...EMPTY_SIGNALS }
  };
}

function stateFromTimeline(
  conversation: Conversation,
  events: SessionEventRecord[],
  rollouts: ConversationTimelineItem[]
): ConversationSessionState {
  return {
    conversation,
    events,
    triggerAttempts: [],
    windows: [],
    turns: rollouts.flatMap((item) =>
      item.type === "rollout"
        ? [
            {
              id: `timeline-turn:${item.id}`,
              rolloutId: item.rolloutId,
              conversation,
              status:
                item.status === "completed"
                  ? "completed"
                  : item.status === "cancelled"
                    ? "cancelled"
                    : "failed",
              startedAt: item.at,
              endedAt: item.at,
              windowIds: [item.id],
              eventIds: [item.id],
              steerCount: 0,
              phases: [],
              proposedActions: [],
              toolResults: []
            } satisfies SessionTurnRecord
          ]
        : []
    ),
    loopExits: []
  };
}

function toTimelineMessage(record: SessionEventRecord): ConversationTimelineItem {
  const event = record.event;
  return {
    type: "message",
    id: `message:${record.id}`,
    at: record.receivedAt,
    eventId: event.id,
    messageId: event.message.id,
    senderId: event.sender.id,
    ...(event.sender.displayName
      ? { senderName: event.sender.displayName }
      : {}),
    isSelf: event.sender.isSelf === true,
    mentionsBot: event.message.mentionsBot,
    text: event.message.text,
    source: event.source.platform
  };
}

function recentRolloutMarkers(
  state: ConversationSessionState | undefined,
  activeRuns: ActiveRunView[],
  conversationKey: string,
  limit: number
): ConversationTimelineItem[] {
  if (limit <= 0) {
    return [];
  }
  const active = activeRuns
    .filter(
      (run) => getConversationKey(run.conversation) === conversationKey
    )
    .map<ConversationTimelineItem>((run) => ({
      type: "rollout",
      id: `rollout:${run.traceId}`,
      at: run.startedAt,
      rolloutId: run.traceId,
      status: "running",
      phase: run.phase
    }));
  const activeIds = new Set(active.flatMap((item) =>
    item.type === "rollout" ? [item.rolloutId] : []
  ));
  const completed = (state?.turns ?? [])
    .filter((turn) => !activeIds.has(turn.rolloutId))
    .map<ConversationTimelineItem>((turn) => ({
      type: "rollout",
      id: `rollout:${turn.rolloutId}`,
      at: turn.startedAt,
      rolloutId: turn.rolloutId,
      status: turn.status,
      durationMs: durationMs(turn.startedAt, turn.endedAt)
    }));
  return [...active, ...completed]
    .sort((left, right) => compareTimelineItems(right, left))
    .slice(0, limit);
}

function toWireRolloutSummary(summary: RolloutSummary): WireRolloutSummary {
  const status: RolloutStatus = summary.status;
  const endedAt = summary.endedAt;
  return {
    id: summary.id,
    ...(summary.conversationKey
      ? { conversationKey: summary.conversationKey }
      : {}),
    status,
    startedAt: summary.startedAt,
    ...(endedAt ? { endedAt } : {}),
    ...(endedAt
      ? { durationMs: durationMs(summary.startedAt, endedAt) }
      : {}),
    ...(summary.failureReason
      ? { failureReason: summary.failureReason }
      : {}),
    generationCount: summary.generationCount,
    toolCount: summary.toolCount,
    actionCount: summary.outboundActionCount,
    messageCount: summary.messageCount,
    signals: summarySignalCounts(summary)
  };
}

function toActiveRolloutSummary(
  run: ActiveRunView,
  stored?: RolloutSummary
): WireRolloutSummary {
  const generationCount = stored?.generationCount ??
    run.generationCount;
  const toolCount = stored?.toolCount ??
    run.toolCount;
  return {
    id: run.traceId,
    conversationKey: getConversationKey(run.conversation),
    status: "running",
    startedAt: run.startedAt,
    phase: run.phase,
    generationCount,
    toolCount,
    actionCount: stored?.outboundActionCount ?? run.actionCount,
    messageCount: stored?.messageCount ?? run.messageCount,
    signals: { ...EMPTY_SIGNALS }
  };
}

function toGenerationSummary(
  record: Extract<RolloutRecord, { type: "generation_completed" }>
): GenerationSummary {
  const usage = readTokenUsage(record.usage);
  const cache = readCacheUsage(record.cacheUsage);
  return {
    id: record.generationId,
    completedAt: record.timestamp,
    inputStateHash: record.inputStateHash,
    messageCount: record.inputMessageCount,
    outputMessageIds: record.outputMessageIds,
    ...(record.model ? { model: record.model } : {}),
    ...(record.finishReason ? { finishReason: record.finishReason } : {}),
    ...(nonNegativeInteger(record.latencyMs) !== undefined
      ? { latencyMs: nonNegativeInteger(record.latencyMs) }
      : {}),
    ...(record.providerRequestId
      ? { providerRequestId: record.providerRequestId }
      : {}),
    ...(usage ? { usage } : {}),
    ...(cache ? { cache } : {})
  };
}

function createFlow(records: RolloutRecord[]): FlowItem[] {
  const flow: FlowItem[] = [];
  const outbound = new Map<
    string,
    Extract<RolloutRecord, { type: "outbound_action_started" }>
  >();
  const finishedOutbound = new Set<string>();
  const dispatchUnknown = new Set<string>();
  let generationNumber = 0;
  for (const record of records) {
    switch (record.type) {
      case "generation_completed": {
        generationNumber += 1;
        const latency = nonNegativeInteger(record.latencyMs);
        flow.push({
          id: `generation:${record.generationId}`,
          type: "generation",
          title: `Generation ${generationNumber}`,
          ...(record.model ? { detail: record.model } : {}),
          status: generationFlowStatus(record.status),
          startedAt: latency
            ? new Date(Date.parse(record.timestamp) - latency).toISOString()
            : record.timestamp,
          endedAt: record.timestamp,
          ...(latency !== undefined ? { durationMs: latency } : {}),
          recordIds: [record.id]
        });
        break;
      }
      case "tool_completed": {
        if (record.errorCode === "result_unknown_after_dispatch") {
          dispatchUnknown.add(record.toolCallId);
        }
        const startedAt =
          record.startedAt ??
          subtractDuration(record.timestamp, record.durationMs);
        flow.push({
          id: `tool:${record.toolCallId}`,
          type: "tool",
          title: record.toolName,
          status: operationFlowStatus(record.status),
          startedAt,
          endedAt: record.timestamp,
          ...(nonNegativeInteger(record.durationMs) !== undefined
            ? { durationMs: nonNegativeInteger(record.durationMs) }
            : {}),
          recordIds: [record.id]
        });
        break;
      }
      case "outbound_action_started":
        outbound.set(record.actionId, record);
        break;
      case "outbound_action_finished": {
        const started = outbound.get(record.actionId);
        finishedOutbound.add(record.actionId);
        flow.push({
          id: `outbound:${record.actionId}`,
          type: "outbound_action",
          title: started?.toolName ?? "Outbound action",
          status: operationFlowStatus(record.status),
          startedAt:
            started?.timestamp ??
            subtractDuration(record.timestamp, record.durationMs),
          endedAt: record.timestamp,
          ...(nonNegativeInteger(record.durationMs) !== undefined
            ? { durationMs: nonNegativeInteger(record.durationMs) }
            : {}),
          recordIds: [
            ...(started ? [started.id] : []),
            record.id
          ]
        });
        break;
      }
      case "span_completed": {
        const isDreaming = record.name.toLowerCase().includes("dream");
        flow.push({
          id: `span:${record.spanId}`,
          type: isDreaming ? "dreaming" : "span",
          title: record.name,
          status: operationFlowStatus(record.status ?? "succeeded"),
          startedAt: record.startedAt,
          endedAt: record.endedAt,
          durationMs: durationMs(record.startedAt, record.endedAt),
          ...(record.parentSpanId ? { parentId: record.parentSpanId } : {}),
          recordIds: [record.id]
        });
        break;
      }
      case "message_committed":
        if (record.source === "dreaming") {
          flow.push({
            id: `dreaming:${record.id}`,
            type: "dreaming",
            title: "Dreaming message committed",
            status: "completed",
            startedAt: record.timestamp,
            endedAt: record.timestamp,
            durationMs: 0,
            recordIds: [record.id]
          });
        }
        break;
      case "rollout_started":
      case "model_session_initialized":
      case "rollout_finished":
        break;
    }
  }
  for (const [actionId, started] of outbound) {
    if (finishedOutbound.has(actionId)) {
      continue;
    }
    flow.push({
      id: `outbound:${actionId}`,
      type: "outbound_action",
      title: started.toolName,
      detail: dispatchUnknown.has(actionId)
        ? "Result unknown after dispatch; action was not retried."
        : "Result unknown after restart; action was not retried.",
      status: "failed",
      startedAt: started.timestamp,
      resultUnknownReason: dispatchUnknown.has(actionId)
        ? "dispatch_response_lost"
        : "process_restarted",
      recordIds: [started.id]
    });
  }
  return flow.sort((left, right) =>
    left.startedAt.localeCompare(right.startedAt) || left.id.localeCompare(right.id)
  );
}

function toRecordView(record: RolloutRecord): RolloutRecordView {
  const raw = record as unknown as Record<string, unknown>;
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (["id", "type", "rolloutId", "timestamp", "stateHash"].includes(key)) {
      continue;
    }
    payload[key] = value;
  }
  const stateHash =
    typeof raw.stateHash === "string"
      ? raw.stateHash
      : record.type === "generation_completed"
        ? record.inputStateHash
        : undefined;
  return {
    id: record.id,
    type: record.type,
    at: record.timestamp,
    ...(stateHash ? { stateHash } : {}),
    payload
  };
}

function createRolloutSignals(
  detail: RolloutDetail,
  active: boolean
): LiveSignal[] {
  const signals: LiveSignal[] = [];
  if (
    !active &&
    detail.summary.status === "failed" &&
    detail.summary.failureReason === "process_restarted"
  ) {
    signals.push({
      id: `rollout:${detail.summary.id}:process-restarted`,
      severity: "error",
      code: "process_restarted",
      title: "Process restarted",
      message: "No rollout_finished record was found, so this rollout is treated as failed.",
      at: detail.summary.startedAt,
      ...(detail.summary.conversationKey
        ? { conversationKey: detail.summary.conversationKey }
        : {}),
      rolloutId: detail.summary.id
    });
  }
  for (const unresolved of detail.unresolvedOutboundActions) {
    signals.push({
      id: `rollout:${detail.summary.id}:outbound:${unresolved.actionId}`,
      severity: "warning",
      code: unresolved.reason,
      title: "Outbound result unknown",
      message: `${unresolved.toolName} may have completed externally; it was not retried.`,
      at: unresolved.startedAt,
      ...(detail.summary.conversationKey
        ? { conversationKey: detail.summary.conversationKey }
        : {}),
      rolloutId: detail.summary.id
    });
  }
  if (detail.truncatedTail) {
    signals.push({
      id: `rollout:${detail.summary.id}:truncated-tail`,
      severity: "warning",
      code: "truncated_jsonl_tail",
      title: "Incomplete final record ignored",
      message: "The final non-terminated JSONL fragment was ignored while reading this rollout.",
      at: detail.summary.endedAt ?? detail.summary.startedAt,
      ...(detail.summary.conversationKey
        ? { conversationKey: detail.summary.conversationKey }
        : {}),
      rolloutId: detail.summary.id
    });
  }
  return signals;
}

function summarySignalCounts(summary: RolloutSummary): SignalCounts {
  return {
    info: 0,
    warning: summary.unresolvedOutboundActionCount,
    error: summary.status === "failed" ? 1 : 0
  };
}

function readTokenUsage(value: unknown): TokenUsage | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const inputTokens = readNonNegativeInteger(record, [
    "inputTokens",
    "promptTokens"
  ]);
  const outputTokens = readNonNegativeInteger(record, [
    "outputTokens",
    "completionTokens"
  ]);
  const totalTokens = readNonNegativeInteger(record, ["totalTokens"]);
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    totalTokens === undefined
  ) {
    return undefined;
  }
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {})
  };
}

function readCacheUsage(value: unknown): CacheUsage | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const readInputTokens = readNonNegativeInteger(record, [
    "readInputTokens",
    "cacheReadInputTokens",
    "cachedInputTokens",
    "readTokens"
  ]);
  const writeInputTokens = readNonNegativeInteger(record, [
    "writeInputTokens",
    "cacheWriteInputTokens",
    "writeTokens"
  ]);
  const prefixReused =
    typeof record.prefixReused === "boolean"
      ? record.prefixReused
      : readInputTokens !== undefined
        ? readInputTokens > 0
        : undefined;
  if (
    readInputTokens === undefined &&
    writeInputTokens === undefined &&
    prefixReused === undefined
  ) {
    return undefined;
  }
  return {
    ...(readInputTokens !== undefined ? { readInputTokens } : {}),
    ...(writeInputTokens !== undefined ? { writeInputTokens } : {}),
    ...(prefixReused !== undefined ? { prefixReused } : {})
  };
}

function readToolName(tool: unknown): string[] {
  const record = asRecord(tool);
  const name = record?.name;
  return typeof name === "string" && name.length ? [name] : [];
}

function committedMessageTimes(records: RolloutRecord[]): Map<string, string> {
  const times = new Map<string, string>();
  for (const record of records) {
    if (record.type === "model_session_initialized") {
      for (const message of record.messages) {
        times.set(message.id, record.timestamp);
      }
    } else if (record.type === "message_committed") {
      times.set(record.message.id, record.timestamp);
    }
  }
  return times;
}

function toModelMessage(
  message: RolloutMessage,
  committedAt?: string
): ModelInputResponse["messages"][number] {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    ...(message.name ? { name: message.name } : {}),
    ...(committedAt ? { committedAt } : {})
  };
}

function commonMessagePrefix(
  previous: readonly RolloutMessage[],
  current: readonly RolloutMessage[]
): number {
  const length = Math.min(previous.length, current.length);
  let index = 0;
  while (index < length && previous[index]?.id === current[index]?.id) {
    index += 1;
  }
  return index;
}

function countUnavailableBinary(value: unknown): number {
  const stack: unknown[] = [value];
  const seen = new WeakSet<object>();
  let count = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== "object") {
      continue;
    }
    if (seen.has(current)) {
      continue;
    }
    seen.add(current);
    const record = current as Record<string, unknown>;
    if (
      record.type === "binary" &&
      typeof record.sha256 === "string" &&
      record.availability !== "stored"
    ) {
      count += 1;
      continue;
    }
    if (Array.isArray(current)) {
      stack.push(...current);
    } else {
      stack.push(...Object.values(record));
    }
  }
  return count;
}

async function serveTraceBlob(
  response: ServerResponse,
  options: ResolvedLiveDebugServerOptions,
  requestedSha256: string
): Promise<void> {
  if (!options.binaryCaptureEnabled) {
    sendJson(response, 404, { error: "Binary capture is disabled" });
    return;
  }
  const sha256 = requestedSha256.toLowerCase();
  if (!SHA256_PATTERN.test(sha256)) {
    throw new HttpError(400, "Invalid blob id.");
  }
  const filePath = traceBlobPath(options.runtime.home.tracesDir, sha256);
  if (!(await fileIfExists(filePath))) {
    sendJson(response, 404, { error: "Blob not found" });
    return;
  }
  if (!(await hasExpectedSha256(filePath, sha256))) {
    sendJson(response, 409, { error: "Blob integrity check failed" });
    return;
  }
  const mediaType = await sniffBlobMediaType(filePath);
  await serveFile(response, filePath, {
    contentType: mediaType,
    untrustedImage: true
  });
}

async function hasExpectedSha256(
  filePath: string,
  expected: string
): Promise<boolean> {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex") === expected;
}

async function sniffBlobMediaType(filePath: string): Promise<string> {
  const handle = await open(filePath, "r");
  try {
    const bytes = Buffer.alloc(32);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const head = bytes.subarray(0, bytesRead);
    if (head.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
      return "image/png";
    }
    if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
      return "image/jpeg";
    }
    if (head.subarray(0, 6).toString("ascii") === "GIF87a" ||
        head.subarray(0, 6).toString("ascii") === "GIF89a") {
      return "image/gif";
    }
    if (
      head.subarray(0, 4).toString("ascii") === "RIFF" &&
      head.subarray(8, 12).toString("ascii") === "WEBP"
    ) {
      return "image/webp";
    }
    if (head.subarray(4, 8).toString("ascii") === "ftyp") {
      const brand = head.subarray(8, 12).toString("ascii");
      if (["avif", "avis"].includes(brand)) {
        return "image/avif";
      }
    }
    return "application/octet-stream";
  } finally {
    await handle.close();
  }
}

function serveSse(
  request: IncomingMessage,
  response: ServerResponse,
  bus: LiveEventBus,
  now: () => Date,
  responses: Set<ServerResponse>
): void {
  response.writeHead(200, {
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Content-Type": "text/event-stream; charset=utf-8",
    "X-Accel-Buffering": "no",
    "X-Content-Type-Options": "nosniff"
  });
  const ready = LiveEventEnvelopeSchema.parse({
    id: 0,
    type: "live.ready",
    at: now().toISOString(),
    data: {
      entity: { kind: "overview" },
      status: "connected",
      summary: "Live API connected"
    }
  });
  if (!response.write(": connected\n\n") || !writeSse(response, ready)) {
    response.end();
    return;
  }

  const lastEventId = parseLastEventId(request.headers["last-event-id"]);
  let unsubscribe: (() => void) | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  let closed = false;

  const cleanup = (): void => {
    closed = true;
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }
    const currentUnsubscribe = unsubscribe;
    unsubscribe = undefined;
    currentUnsubscribe?.();
    responses.delete(response);
  };
  const closeSlowClient = (): void => {
    cleanup();
    if (!response.destroyed && !response.writableEnded) {
      response.end();
    }
  };

  unsubscribe = bus.subscribe({
    ...(lastEventId !== undefined ? { lastEventId } : {}),
    onEvent(event) {
      if (closed) return;
      try {
        if (writeSse(response, summarizeLiveEvent(event))) return;
        // A stalled SSE consumer otherwise lets ServerResponse retain an
        // unbounded writable queue. The client can reconnect with its last
        // event id and replay from the bounded event bus.
        closeSlowClient();
      } catch {
        // Socket races are diagnostic failures, not chat failures.
        closeSlowClient();
      }
    }
  });
  // subscribe() replays buffered events synchronously. If replay already hit
  // backpressure, remove the subscription that was just returned.
  if (closed) {
    const currentUnsubscribe = unsubscribe;
    unsubscribe = undefined;
    currentUnsubscribe?.();
    return;
  }

  heartbeat = setInterval(() => {
    const heartbeatEvent = LiveEventEnvelopeSchema.parse({
      id: 0,
      type: "live.heartbeat",
      at: now().toISOString(),
      data: {
        entity: { kind: "overview" },
        status: "connected",
        summary: "Live API heartbeat"
      }
    });
    if (!writeSse(response, heartbeatEvent)) {
      closeSlowClient();
    }
  }, 15_000);

  responses.add(response);
  request.once("close", cleanup);
  response.once("close", cleanup);
}

function summarizeLiveEvent(
  event: RuntimeLiveEventEnvelope
): LiveEventEnvelope {
  const data = asRecord(event.data) ?? {};
  const conversationKey = readString(data.conversationKey);
  const rolloutId =
    readString(data.rolloutId) ??
    readString(data.traceId) ??
    readString(data.id);
  const entity = readWireEntity(data.entity) ??
    (event.type.startsWith("session.")
      ? {
          kind: "conversation" as const,
          ...(conversationKey ? { id: conversationKey } : {})
        }
      : event.type.startsWith("agent.") ||
          event.type.startsWith("trace.") ||
          event.type.startsWith("rollout.")
        ? {
            kind: "rollout" as const,
            ...(rolloutId ? { id: rolloutId } : {})
          }
        : event.type.startsWith("signal.") || event.type.startsWith("diagnostic.")
          ? {
              kind: "signal" as const,
              ...(rolloutId ? { id: rolloutId } : {})
            }
          : { kind: "overview" as const });
  const status =
    readString(data.status) ?? readString(data.phase) ?? liveEventStatus(event.type);
  return LiveEventEnvelopeSchema.parse({
    id: event.id,
    type: event.type,
    at: event.at,
    data: {
      entity,
      ...(status ? { status } : {}),
      summary: event.type
    }
  });
}

function readWireEntity(
  value: unknown
): LiveEventEnvelope["data"]["entity"] | undefined {
  const record = asRecord(value);
  const kind = record?.kind;
  if (
    kind !== "overview" &&
    kind !== "conversation" &&
    kind !== "rollout" &&
    kind !== "signal"
  ) {
    return undefined;
  }
  const id = readString(record?.id);
  return { kind, ...(id ? { id } : {}) };
}

function liveEventStatus(type: string): string | undefined {
  if (type.endsWith(".completed") || type.endsWith(".recorded")) {
    return "completed";
  }
  if (type.endsWith(".failed")) {
    return "failed";
  }
  if (type.endsWith(".started")) {
    return "running";
  }
  return undefined;
}

async function serveStatic(
  response: ServerResponse,
  uiDir: string,
  pathname: string
): Promise<void> {
  const target = resolveStaticPath(uiDir, pathname);
  if (!target) {
    sendJson(response, 403, { error: "Forbidden" });
    return;
  }
  const candidate = await pickExistingAsset(target, uiDir);
  if (!candidate) {
    sendJson(response, 404, { error: "Not found" });
    return;
  }
  await serveFile(response, candidate);
}

async function serveFile(
  response: ServerResponse,
  candidate: string,
  options: { untrustedImage?: boolean; contentType?: string } = {}
): Promise<void> {
  response.writeHead(200, {
    "Content-Type": options.contentType ?? contentType(candidate),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...(options.untrustedImage
      ? {
          "Content-Security-Policy": "default-src 'none'; sandbox",
          "Cross-Origin-Resource-Policy": "same-origin"
        }
      : {})
  });
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(candidate);
    stream.on("error", reject);
    stream.on("end", resolve);
    stream.pipe(response);
  });
}

function isSupportedStickerAsset(filePath: string): boolean {
  return [".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(
    path.extname(filePath).toLowerCase()
  );
}

function resolveStaticPath(uiDir: string, pathname: string): string | undefined {
  let decoded = "/";
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  const relativePath = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const resolved = path.resolve(uiDir, relativePath);
  return isWithinDirectory(uiDir, resolved) ? resolved : undefined;
}

async function pickExistingAsset(
  target: string,
  uiDir: string
): Promise<string | undefined> {
  const direct = await fileIfExists(target);
  return direct ?? fileIfExists(path.join(uiDir, "index.html"));
}

async function fileIfExists(target: string): Promise<string | undefined> {
  try {
    const stats = await stat(target);
    return stats.isFile() ? target : undefined;
  } catch {
    return undefined;
  }
}

function isWithinDirectory(directory: string, target: string): boolean {
  const relative = path.relative(directory, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(sanitizeUntrustedValue(value)));
}

function writeSse(response: ServerResponse, event: LiveEventEnvelope): boolean {
  let payload = "";
  if (typeof event.id === "number" && event.id > 0) {
    payload += `id: ${event.id}\n`;
  } else if (typeof event.id === "string") {
    payload += `id: ${event.id}\n`;
  }
  payload += `event: live\ndata: ${JSON.stringify(event)}\n\n`;
  return response.write(payload);
}

function parseLastEventId(value: string | string[] | undefined): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) {
    return undefined;
  }
  const numeric = Number(raw);
  return Number.isInteger(numeric) && numeric >= 0 ? numeric : undefined;
}

function parsePageLimit(url: URL): number {
  const raw = url.searchParams.get("limit");
  if (raw === null || raw === "") {
    return DEFAULT_PAGE_LIMIT;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0 || value > MAX_PAGE_LIMIT) {
    throw new HttpError(400, `limit must be between 1 and ${MAX_PAGE_LIMIT}.`);
  }
  return value;
}

function parseConversationKey(key: string): Conversation {
  const separator = key.indexOf(":");
  const kind = key.slice(0, separator);
  const id = key.slice(separator + 1);
  if ((kind !== "group" && kind !== "private") || !id) {
    throw new HttpError(400, "Invalid conversation key.");
  }
  return { kind, id };
}

function historyConversationMatches(
  record: SessionEventRecord,
  query: string
): boolean {
  if (!query) {
    return true;
  }
  const event = record.event;
  return [
    getConversationKey(event.conversation),
    event.conversation.name,
    event.message.text,
    event.message.rawText,
    event.message.id,
    event.sender.id,
    event.sender.displayName
  ].some((value) => value?.toLowerCase().includes(query));
}

function isConversationAfterCursor(
  value: ConversationSummary,
  cursor: ConversationPageCursor
): boolean {
  const lastAt = value.lastAt ?? "";
  return lastAt < cursor.lastAt ||
    (lastAt === cursor.lastAt && value.key > cursor.key);
}

function decodeConversationCursor(value: string): ConversationPageCursor {
  const parsed = decodeCursor(value);
  if (
    typeof parsed.lastAt !== "string" ||
    typeof parsed.key !== "string" ||
    !parsed.key
  ) {
    throw new HttpError(400, "Invalid conversation cursor.");
  }
  return { lastAt: parsed.lastAt, key: parsed.key };
}

function decodeRolloutCursor(value: string): RolloutPageCursor {
  const parsed = decodeCursor(value);
  if (parsed.phase !== "active" && parsed.phase !== "storage") {
    throw new HttpError(400, "Invalid rollout cursor.");
  }
  if (
    parsed.activeOffset !== undefined &&
    (!Number.isInteger(parsed.activeOffset) || Number(parsed.activeOffset) < 0)
  ) {
    throw new HttpError(400, "Invalid rollout cursor.");
  }
  if (
    parsed.storageCursor !== undefined &&
    typeof parsed.storageCursor !== "string"
  ) {
    throw new HttpError(400, "Invalid rollout cursor.");
  }
  return {
    phase: parsed.phase,
    ...(typeof parsed.activeOffset === "number"
      ? { activeOffset: parsed.activeOffset }
      : {}),
    ...(typeof parsed.storageCursor === "string"
      ? { storageCursor: parsed.storageCursor }
      : {})
  };
}

function encodeCursor(value: object): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeCursor(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("cursor is not an object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new HttpError(400, "Invalid cursor.", error);
  }
}

function rolloutMatches(
  summary: WireRolloutSummary,
  query: string,
  status?: RolloutStatus
): boolean {
  if (status && summary.status !== status) {
    return false;
  }
  const normalized = query.toLowerCase();
  return !normalized ||
    [summary.id, summary.conversationKey, summary.model, summary.phase]
      .some((value) => value?.toLowerCase().includes(normalized));
}

function compareWireRollouts(
  left: WireRolloutSummary,
  right: WireRolloutSummary
): number {
  return right.startedAt.localeCompare(left.startedAt) || left.id.localeCompare(right.id);
}

function compareTimelineItems(
  left: ConversationTimelineItem,
  right: ConversationTimelineItem
): number {
  return left.at.localeCompare(right.at) || left.id.localeCompare(right.id);
}

function generationFlowStatus(
  status: "completed" | "failed" | "cancelled"
): FlowItem["status"] {
  return status;
}

function operationFlowStatus(
  status: "succeeded" | "failed" | "cancelled"
): FlowItem["status"] {
  return status === "succeeded" ? "completed" : status;
}

function subtractDuration(timestamp: string, duration?: number): string {
  const safeDuration = nonNegativeInteger(duration) ?? 0;
  const end = Date.parse(timestamp);
  return Number.isFinite(end)
    ? new Date(end - safeDuration).toISOString()
    : timestamp;
}

function durationMs(startedAt: string, endedAt: string): number {
  const duration = Date.parse(endedAt) - Date.parse(startedAt);
  return Number.isFinite(duration) && duration >= 0 ? duration : 0;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

function readNonNegativeInteger(
  record: Record<string, unknown>,
  keys: string[]
): number | undefined {
  for (const key of keys) {
    const value = nonNegativeInteger(record[key]);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length ? value : undefined;
}

function readOptionalQuery(url: URL, key: string): string | undefined {
  const value = url.searchParams.get(key);
  return value && value.length ? value : undefined;
}

function decodePathSegment(value: string): string {
  try {
    const decoded = decodeURIComponent(value);
    if (!decoded) {
      throw new Error("empty path segment");
    }
    return decoded;
  } catch (error) {
    throw new HttpError(400, "Invalid URL path segment.", error);
  }
}

function latestTimestamp(values: string[]): string | undefined {
  return values
    .filter((value) => Number.isFinite(Date.parse(value)))
    .sort((left, right) => right.localeCompare(left))[0];
}

function runningRuns(runStore: LiveRunStore, now: () => Date): ActiveRunView[] {
  return runStore.getActiveRuns(now).filter((run) => run.status === "running");
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && /not found|was not found/i.test(error.message);
}

function isInvalidInputError(error: unknown): boolean {
  return error instanceof Error && /invalid|limit must/i.test(error.message);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function contentType(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".json":
    case ".map":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".avif":
      return "image/avif";
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}

function emptyStickerSnapshot(
  generatedAt: string,
  catalogInput: StickerCatalogQuery = {}
): Record<string, unknown> {
  const catalog = normalizeStickerCatalogQuery(catalogInput);
  return {
    available: false,
    unavailableReason:
      "Sticker subsystem is not configured. Configure an embedding model to enable it.",
    generatedAt,
    scraping: { configuredEnabled: false, effectiveEnabled: false },
    processing: {
      queued: 0,
      running: 0,
      failed: 0,
      ready: 0,
      duplicates: 0
    },
    embedding: { rowCount: 0, indexState: "empty" },
    jobs: [],
    catalog: { offset: catalog.offset, limit: catalog.limit, total: 0 },
    stickers: []
  };
}

function parseStickerCatalogQuery(url: URL): StickerCatalogQuery {
  const status = url.searchParams.get("status");
  const source = url.searchParams.get("source");
  const offset = parseFiniteNumber(url.searchParams.get("offset"));
  const limit = parseFiniteNumber(url.searchParams.get("limit"));
  return {
    ...(offset !== undefined ? { offset } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(url.searchParams.has("query")
      ? { query: url.searchParams.get("query") ?? "" }
      : {}),
    ...(status === "ready" || status === "processing" || status === "failed"
      ? { status }
      : {}),
    ...(source === "mface" || source === "image-sticker" ? { source } : {})
  };
}

function parseFiniteNumber(value: string | null): number | undefined {
  if (value === null || value.trim() === "") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isAllowedRequest(request: IncomingMessage): boolean {
  const hostHeader = Array.isArray(request.headers.host)
    ? request.headers.host[0]
    : request.headers.host;
  if (!hostHeader) {
    return false;
  }
  const origin = request.headers.origin;
  if (!origin) {
    return true;
  }
  try {
    const parsed = new URL(origin);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.host.toLowerCase() === hostHeader.toLowerCase()
    );
  } catch {
    return false;
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    options?: unknown
  ) {
    super(message, options ? { cause: options } : undefined);
  }
}

export function resolveDefaultTraceUiDir(fromUrl: string): string {
  const moduleDir = path.dirname(fileURLToPath(fromUrl));
  const candidates = [
    path.join(moduleDir, "live-ui"),
    path.resolve(moduleDir, "../dist/live-ui"),
    path.resolve(moduleDir, "../../trace/dist")
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}
