import { collectDiagnostics } from "./diagnostics";
import {
  asRecord,
  conversationKey,
  durationMs,
  jsonPreview,
  readString,
  readStringArray,
  shortId,
  sortByTime,
  truncate
} from "./format";
import { listJsonlFileNames, readJsonlDirectory } from "./jsonl";
import type { GestaltHome } from "../home/resolveGestaltHome";
import { visibleMessageText } from "../privacy/stickerRedaction";
import type {
  ActiveRunView,
  AgentTurnTrace,
  ConversationSessionSnapshot,
  ConversationView,
  Diagnostic,
  EventTimelineItem,
  JsonlEntry,
  ObservationRecord,
  SessionSnapshot,
  SessionTurnRecord,
  TimelineItem,
  TraceDetail,
  TraceSummary,
  TraceWorkspace,
  TurnTimelineItem,
  WaterfallSpan
} from "./viewTypes";

export interface LoadLiveWorkspaceInput {
  home: GestaltHome;
  sessionSnapshot: SessionSnapshot;
  activeRuns: ActiveRunView[];
  now?: () => Date;
}

export interface LoadLiveTraceDetailInput extends LoadLiveWorkspaceInput {
  traceId: string;
}

export async function loadLiveWorkspace(
  input: LoadLiveWorkspaceInput
): Promise<TraceWorkspace> {
  const now = input.now ?? (() => new Date());
  const [sessionEntries, traceEntries, sessionFiles, traceFiles] =
    await Promise.all([
      readJsonlDirectory<SessionSnapshot>(input.home.sessionsDir),
      readJsonlDirectory<AgentTurnTrace>(input.home.tracesDir),
      listJsonlFileNames(input.home.sessionsDir),
      listJsonlFileNames(input.home.tracesDir)
    ]);
  const latestSession = pickLatestSession(sessionEntries);
  const completedTraces = traceEntries.map((entry) => entry.value);
  const activeTraces = input.activeRuns.map((run) => run.trace);
  const traces = mergeTraces(completedTraces, activeTraces);
  const activeTraceIds = new Set(input.activeRuns.map((run) => run.traceId));
  const baseTraceSummaries = traces.map((trace) =>
    summarizeTrace(trace, [], input.activeRuns.find((run) => run.traceId === trace.id))
  );
  const diagnostics = collectDiagnostics({
    conversations: input.sessionSnapshot.conversations,
    traces,
    traceSummaries: baseTraceSummaries,
    activeTraceIds
  });
  const traceSummaries = sortByTime(
    traces.map((trace) =>
      summarizeTrace(
        trace,
        diagnosticsForTrace(trace.id, diagnostics),
        input.activeRuns.find((run) => run.traceId === trace.id)
      )
    ),
    (trace) => trace.startedAt
  ).reverse();
  const traceById = new Map(traces.map((trace) => [trace.id, trace]));

  return {
    home: {
      root: input.home.root,
      sessionsDir: input.home.sessionsDir,
      tracesDir: input.home.tracesDir
    },
    generatedAt: now().toISOString(),
    sessionExportCount: sessionEntries.length,
    traceCount: traces.length,
    activeRunCount: input.activeRuns.length,
    sessionFiles,
    traceFiles,
    ...(latestSession
      ? {
          latestSession: {
            exportedAt: latestSession.value.exportedAt,
            fileName: latestSession.fileName,
            line: latestSession.line
          }
        }
      : {}),
    conversations: sortByTime(
      input.sessionSnapshot.conversations.map((conversation) =>
        buildConversationView(conversation, traceById, diagnostics, input.activeRuns)
      ),
      (conversation) => conversation.lastAt
    ).reverse(),
    traces: traceSummaries,
    activeRuns: input.activeRuns,
    diagnostics
  };
}

export async function loadLiveTraceDetail(
  input: LoadLiveTraceDetailInput
): Promise<TraceDetail | undefined> {
  const workspace = await loadLiveWorkspace(input);
  const activeRun = input.activeRuns.find(
    (run) => run.traceId === input.traceId || run.traceId.startsWith(input.traceId)
  );
  const trace =
    activeRun?.trace ??
    (await readJsonlDirectory<AgentTurnTrace>(input.home.tracesDir))
      .map((entry) => entry.value)
      .find(
        (candidate) =>
          candidate.id === input.traceId || candidate.id.startsWith(input.traceId)
      );

  if (!trace) {
    return undefined;
  }

  const diagnostics = diagnosticsForTrace(trace.id, workspace.diagnostics);
  const summary = summarizeTrace(trace, diagnostics, activeRun);
  const related = findRelatedSessionRecord(workspace, trace);

  return {
    workspace: {
      home: workspace.home,
      generatedAt: workspace.generatedAt,
      sessionExportCount: workspace.sessionExportCount,
      traceCount: workspace.traceCount,
      activeRunCount: workspace.activeRunCount,
      sessionFiles: workspace.sessionFiles,
      traceFiles: workspace.traceFiles,
      ...(workspace.latestSession
        ? { latestSession: workspace.latestSession }
        : {}),
      activeRuns: workspace.activeRuns,
      diagnostics: workspace.diagnostics
    },
    summary,
    trace,
    waterfall: buildWaterfall(trace),
    ...(related.conversationKey
      ? { relatedConversation: related.conversationKey }
      : {}),
    ...(related.turn ? { relatedTurn: related.turn } : {}),
    ...(related.event ? { relatedEvent: related.event } : {}),
    diagnostics
  };
}

function pickLatestSession(
  entries: JsonlEntry<SessionSnapshot>[]
): JsonlEntry<SessionSnapshot> | undefined {
  return [...entries].sort((a, b) => {
    const byTime = Date.parse(b.value.exportedAt) - Date.parse(a.value.exportedAt);
    if (Number.isFinite(byTime) && byTime !== 0) {
      return byTime;
    }
    return b.line - a.line;
  })[0];
}

function mergeTraces(
  completedTraces: AgentTurnTrace[],
  activeTraces: AgentTurnTrace[]
): AgentTurnTrace[] {
  const activeIds = new Set(activeTraces.map((trace) => trace.id));
  return [
    ...activeTraces,
    ...completedTraces.filter((trace) => !activeIds.has(trace.id))
  ];
}

function buildConversationView(
  conversation: ConversationSessionSnapshot,
  traceById: Map<string, AgentTurnTrace>,
  diagnostics: Diagnostic[],
  activeRuns: ActiveRunView[]
): ConversationView {
  const key = conversationKey(conversation.conversation);
  const eventItems = (conversation.events ?? []).map(toEventItem);
  const turnItems = (conversation.turns ?? []).map((turn) =>
    buildTurnItem({
      id: turn.id,
      at: turn.startedAt,
      traceId: turn.traceId,
      status: turn.status,
      fromSeq: turn.fromSeq,
      toSeq: turn.toSeq,
      eventSeqs: turn.eventSeqs ?? [],
      durationMs: durationMs(turn.startedAt, turn.endedAt),
      phases: turn.phases ?? [],
      proposedActions: turn.proposedActions,
      toolResults: turn.toolResults,
      trace: traceById.get(turn.traceId),
      diagnostics,
      isActive: false
    })
  );
  const activeTurnItems = activeRuns
    .filter((run) => conversationKey(run.conversation) === key)
    .filter((run) => !turnItems.some((turn) => turn.traceId === run.traceId))
    .map((run) =>
      buildTurnItem({
        id: `active:${run.traceId}`,
        at: run.startedAt,
        traceId: run.traceId,
        status: run.status === "running" ? run.phase : run.status,
        fromSeq: run.window.fromSeq,
        toSeq: run.window.toSeq,
        eventSeqs: run.window.eventSeqs,
        durationMs: durationMs(run.startedAt, run.trace.endedAt),
        phases: run.phases,
        proposedActions: run.trace.proposedActions,
        toolResults: run.trace.toolResults,
        trace: run.trace,
        diagnostics,
        isActive: true
      })
    );
  const windowItems = (conversation.windows ?? []).map((window) => ({
    type: "window" as const,
    id: window.id,
    at: window.closedAt,
    reason: window.reason,
    fromSeq: window.fromSeq,
    toSeq: window.toSeq,
    eventSeqs: window.eventSeqs ?? []
  }));
  const loopExitItems = (conversation.loopExits ?? []).map((exit) => ({
    type: "loopExit" as const,
    id: exit.id,
    at: exit.endedAt,
    triggerName: exit.triggerName,
    reason: exit.reason,
    ...(exit.description ? { description: exit.description } : {}),
    turnIds: exit.turnIds ?? []
  }));
  const eventIds = new Set((conversation.events ?? []).map((event) => event.event.id));
  const traceIds = new Set([
    ...(conversation.turns ?? []).map((turn) => turn.traceId),
    ...activeRuns
      .filter((run) => conversationKey(run.conversation) === key)
      .map((run) => run.traceId)
  ]);
  const conversationDiagnostics = diagnostics.filter((diagnostic) => {
    if (diagnostic.conversationKey === key) {
      return true;
    }
    if (diagnostic.eventId && eventIds.has(diagnostic.eventId)) {
      return true;
    }
    return Boolean(diagnostic.traceId && traceIds.has(diagnostic.traceId));
  });
  const timeline = sortByTime<TimelineItem>(
    [...eventItems, ...windowItems, ...turnItems, ...activeTurnItems, ...loopExitItems],
    (item) => item.at
  );
  const lastEvent = conversation.events?.at(-1);
  const lastActiveRun = activeRuns
    .filter((run) => conversationKey(run.conversation) === key)
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
  const lastAt = lastActiveRun?.updatedAt ?? lastEvent?.receivedAt;
  const lastText =
    lastEvent?.event.type === "MessageReceived"
      ? visibleMessageText(lastEvent.event)
      : undefined;

  return {
    key,
    conversation: conversation.conversation,
    nextSeq: conversation.nextSeq,
    eventCount: conversation.events?.length ?? 0,
    windowCount: conversation.windows?.length ?? 0,
    turnCount: (conversation.turns?.length ?? 0) + activeTurnItems.length,
    loopExitCount: conversation.loopExits?.length ?? 0,
    selfMessageCount: (conversation.events ?? []).filter((event) =>
      Boolean(event.event.sender.isSelf)
    ).length,
    ...(lastAt ? { lastAt } : {}),
    ...(lastText ? { lastText: truncate(lastText, 140) } : {}),
    diagnostics: conversationDiagnostics,
    timeline
  };
}

function buildTurnItem(input: {
  id: string;
  at: string;
  traceId: string;
  status: string;
  fromSeq: number;
  toSeq: number;
  eventSeqs: number[];
  durationMs: number;
  phases: TurnTimelineItem["phases"];
  proposedActions: unknown;
  toolResults: unknown;
  trace: AgentTurnTrace | undefined;
  diagnostics: Diagnostic[];
  isActive: boolean;
}): TurnTimelineItem {
  const turnDiagnostics = input.diagnostics.filter((diagnostic) => {
    if (diagnostic.turnId === input.id || diagnostic.traceId === input.traceId) {
      return true;
    }
    return Boolean(input.trace && diagnostic.eventId === input.trace.eventId);
  });

  return {
    type: "turn",
    id: input.id,
    at: input.at,
    traceId: input.traceId,
    shortTraceId: shortId(input.traceId),
    status: input.status,
    fromSeq: input.fromSeq,
    toSeq: input.toSeq,
    eventSeqs: input.eventSeqs,
    durationMs: input.durationMs,
    phases: input.phases,
    actionNames: actionNames(input.proposedActions),
    toolStatuses: toolStatuses(input.toolResults),
    hasTrace: Boolean(input.trace),
    isActive: input.isActive,
    diagnostics: turnDiagnostics
  };
}

function toEventItem(record: ConversationSessionSnapshot["events"][number]): EventTimelineItem {
  const source = asRecord(record.event.source);
  const sourceLabel = [readString(source.platform), readString(source.connector)]
    .filter(Boolean)
    .join("/");
  return {
    type: "event",
    id: `${record.seq}:${record.event.id}`,
    at: record.receivedAt,
    seq: record.seq,
    eventId: record.event.id,
    messageId: record.event.message.id,
    senderId: record.event.sender.id,
    ...(record.event.sender.displayName
      ? { senderName: record.event.sender.displayName }
      : {}),
    isSelf: Boolean(record.event.sender.isSelf),
    mentionsBot: Boolean(record.event.message.mentionsBot),
    text: truncate(
      record.event.type === "MessageReceived"
        ? visibleMessageText(record.event)
        : record.event.type,
      360
    ),
    ...(sourceLabel ? { source: sourceLabel } : {})
  };
}

function summarizeTrace(
  trace: AgentTurnTrace,
  diagnostics: Diagnostic[],
  activeRun?: ActiveRunView
): TraceSummary {
  const model = readTraceModel(trace);
  return {
    id: trace.id,
    shortId: shortId(trace.id),
    eventId: trace.eventId,
    startedAt: trace.startedAt,
    endedAt: trace.endedAt,
    durationMs: durationMs(trace.startedAt, trace.endedAt),
    status: traceStatus(trace, diagnostics, activeRun),
    spanCount: trace.spans?.length ?? 0,
    observationCount: trace.observations?.length ?? 0,
    actionNames: actionNames(trace.proposedActions),
    toolStatuses: toolStatuses(trace.toolResults),
    ...(model ? { model } : {}),
    ...(activeRun ? { phase: activeRun.phase } : {}),
    diagnostics
  };
}

function buildWaterfall(trace: AgentTurnTrace): WaterfallSpan[] {
  const startedAt = Date.parse(trace.startedAt);
  const total = Math.max(1, durationMs(trace.startedAt, trace.endedAt));
  const spanRows = (trace.spans ?? []).map((span) => {
    const status = readString(asRecord(span.attributes).status);
    return waterfallItem({
      id: span.id,
      name: span.name,
      type: "span",
      startedAt: span.startedAt,
      endedAt: span.endedAt,
      status:
        status === "error"
          ? "error"
          : status === "running"
            ? "running"
            : "ok",
      traceStartedAt: startedAt,
      total
    });
  });
  const observationRows = (trace.observations ?? [])
    .filter((observation) => observation.type !== "span")
    .map((observation) =>
      waterfallItem({
        id: observation.id,
        name: observation.name,
        type: observation.type,
        startedAt: observation.startedAt ?? trace.startedAt,
        endedAt: observation.endedAt ?? observation.startedAt ?? trace.endedAt,
        status: observation.level === "ERROR" ? "error" : "ok",
        traceStartedAt: startedAt,
        total
      })
    );
  return sortByTime([...spanRows, ...observationRows], (row) => row.startedAt);
}

function waterfallItem(input: {
  id: string;
  name: string;
  type: string;
  startedAt: string;
  endedAt: string;
  status: WaterfallSpan["status"];
  traceStartedAt: number;
  total: number;
}): WaterfallSpan {
  const start = Date.parse(input.startedAt);
  const offset = Number.isFinite(start)
    ? Math.max(0, start - input.traceStartedAt)
    : 0;
  const elapsed = durationMs(input.startedAt, input.endedAt);
  const kind = normalizeObservationKind(input.type);
  return {
    id: input.id,
    name: input.name,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    durationMs: elapsed,
    offsetPct: Math.min(100, (offset / input.total) * 100),
    widthPct: Math.max(1, Math.min(100, (elapsed / input.total) * 100)),
    status: input.status,
    kind
  };
}

function normalizeObservationKind(type: string): WaterfallSpan["kind"] {
  if (
    type === "generation" ||
    type === "tool" ||
    type === "agent" ||
    type === "event" ||
    type === "chain"
  ) {
    return type;
  }
  return "span";
}

function actionNames(actions: unknown): string[] {
  if (!Array.isArray(actions)) {
    return [];
  }
  return actions
    .map((action) => readString(asRecord(action).toolName))
    .filter((name): name is string => Boolean(name));
}

function toolStatuses(results: unknown): string[] {
  if (!Array.isArray(results)) {
    return [];
  }
  return results
    .map((result) => readString(asRecord(result).status))
    .filter((status): status is string => Boolean(status));
}

function traceStatus(
  trace: AgentTurnTrace,
  diagnostics: Diagnostic[],
  activeRun?: ActiveRunView
): TraceSummary["status"] {
  if (activeRun?.status === "running") {
    return "running";
  }
  if (
    activeRun?.status === "failed" ||
    diagnostics.some((diagnostic) => diagnostic.severity === "error") ||
    (trace.spans ?? []).some(
      (span) => readString(asRecord(span.attributes).status) === "error"
    ) ||
    (trace.observations ?? []).some((observation) => observation.level === "ERROR")
  ) {
    return "error";
  }
  if (diagnostics.some((diagnostic) => diagnostic.severity === "warning")) {
    return "warning";
  }
  return "ok";
}

function readTraceModel(trace: AgentTurnTrace): string | undefined {
  const modelSpan = (trace.spans ?? []).find((span) => span.name === "model.decide");
  const modelFromSpan = readString(asRecord(modelSpan?.attributes).model);
  if (modelFromSpan) {
    return modelFromSpan;
  }
  return (trace.observations ?? [])
    .map((observation: ObservationRecord) => observation.model)
    .find((model): model is string => Boolean(model));
}

function diagnosticsForTrace(
  traceId: string,
  diagnostics: Diagnostic[]
): Diagnostic[] {
  return diagnostics.filter((diagnostic) => diagnostic.traceId === traceId);
}

function findRelatedSessionRecord(
  workspace: TraceWorkspace,
  trace: AgentTurnTrace
): {
  conversationKey?: string;
  turn?: SessionTurnRecord;
  event?: EventTimelineItem;
} {
  for (const conversation of workspace.conversations) {
    const turnItem = conversation.timeline.find(
      (item) => item.type === "turn" && item.traceId === trace.id
    );
    const eventItem = conversation.timeline.find(
      (item) => item.type === "event" && item.eventId === trace.eventId
    );
    if (turnItem || eventItem) {
      const turn =
        turnItem?.type === "turn" ? findTurn(workspace, turnItem.id) : undefined;
      return {
        conversationKey: conversation.key,
        ...(turn ? { turn } : {}),
        ...(eventItem?.type === "event" ? { event: eventItem } : {})
      };
    }
  }
  return {};
}

function findTurn(
  workspace: TraceWorkspace,
  turnId: string
): SessionTurnRecord | undefined {
  for (const conversation of workspace.conversations) {
    const turn = conversation.timeline.find(
      (item) => item.type === "turn" && item.id === turnId
    );
    if (!turn || turn.type !== "turn") {
      continue;
    }
    if (!isSessionTurnStatus(turn.status)) {
      return undefined;
    }
    return {
      id: turn.id,
      traceId: turn.traceId,
      conversation: conversation.conversation,
      status: turn.status,
      startedAt: turn.at,
      endedAt: new Date(Date.parse(turn.at) + turn.durationMs).toISOString(),
      windowIds: [],
      fromSeq: turn.fromSeq,
      toSeq: turn.toSeq,
      eventSeqs: turn.eventSeqs,
      steerCount: 0,
      phases: turn.phases,
      proposedActions: [],
      toolResults: []
    };
  }
  return undefined;
}

function isSessionTurnStatus(
  value: string
): value is SessionTurnRecord["status"] {
  return value === "completed" || value === "cancelled" || value === "failed";
}

export function describeObservation(observation: ObservationRecord): string {
  if (observation.type === "generation") {
    const output = asRecord(observation.output);
    return jsonPreview(output.content ?? output.finishReason ?? observation.metadata);
  }
  if (observation.type === "tool") {
    return jsonPreview(observation.output ?? observation.metadata);
  }
  return jsonPreview(observation.metadata ?? observation.statusMessage);
}

export function traceToolNames(trace: AgentTurnTrace): string[] {
  const fromActions = actionNames(trace.proposedActions);
  const fromToolObservations = (trace.observations ?? [])
    .filter((observation) => observation.type === "tool")
    .map((observation) => observation.name);
  return Array.from(
    new Set([...fromActions, ...fromToolObservations, ...readStringArray([])])
  );
}
