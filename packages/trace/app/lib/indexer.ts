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
import { resolveGestaltHome } from "./gestaltHome";
import { listJsonlFileNames, readJsonlDirectory } from "./jsonl";
import type {
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
  WaterfallSpan
} from "./types";

export async function loadTraceWorkspace(): Promise<TraceWorkspace> {
  const home = resolveGestaltHome();
  const [sessionEntries, traceEntries, sessionFiles, traceFiles] = await Promise.all([
    readJsonlDirectory<SessionSnapshot>(home.sessionsDir),
    readJsonlDirectory<AgentTurnTrace>(home.tracesDir),
    listJsonlFileNames(home.sessionsDir),
    listJsonlFileNames(home.tracesDir)
  ]);
  const latestSession = pickLatestSession(sessionEntries);
  const traces = traceEntries.map((entry) => entry.value);
  const conversations = latestSession?.value.conversations ?? [];
  const baseTraceSummaries = traces.map((trace) => summarizeTrace(trace, []));
  const diagnostics = collectDiagnostics({
    conversations,
    traces,
    traceSummaries: baseTraceSummaries
  });
  const traceSummaries = sortByTime(
    traces.map((trace) => summarizeTrace(trace, diagnosticsForTrace(trace.id, diagnostics))),
    (trace) => trace.startedAt
  ).reverse();
  const traceById = new Map(traces.map((trace) => [trace.id, trace]));

  return {
    home,
    generatedAt: new Date().toISOString(),
    sessionExportCount: sessionEntries.length,
    traceCount: traces.length,
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
      conversations.map((conversation) =>
        buildConversationView(conversation, traceById, diagnostics)
      ),
      (conversation) => conversation.lastAt
    ).reverse(),
    traces: traceSummaries,
    diagnostics
  };
}

export async function loadTraceDetail(traceId: string): Promise<TraceDetail | undefined> {
  const workspace = await loadTraceWorkspace();
  const home = resolveGestaltHome();
  const traceEntries = await readJsonlDirectory<AgentTurnTrace>(home.tracesDir);
  const trace = traceEntries
    .map((entry) => entry.value)
    .find((candidate) => candidate.id === traceId || candidate.id.startsWith(traceId));
  if (!trace) {
    return undefined;
  }

  const diagnostics = diagnosticsForTrace(trace.id, workspace.diagnostics);
  const summary = summarizeTrace(trace, diagnostics);
  const related = findRelatedSessionRecord(workspace, trace);

  return {
    workspace: {
      home: workspace.home,
      generatedAt: workspace.generatedAt,
      sessionExportCount: workspace.sessionExportCount,
      traceCount: workspace.traceCount,
      sessionFiles: workspace.sessionFiles,
      traceFiles: workspace.traceFiles,
      ...(workspace.latestSession ? { latestSession: workspace.latestSession } : {}),
      diagnostics: workspace.diagnostics
    },
    summary,
    trace,
    waterfall: buildWaterfall(trace),
    ...(related.conversationKey ? { relatedConversation: related.conversationKey } : {}),
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

function buildConversationView(
  conversation: ConversationSessionSnapshot,
  traceById: Map<string, AgentTurnTrace>,
  diagnostics: Diagnostic[]
): ConversationView {
  const key = conversationKey(conversation.conversation);
  const eventItems = (conversation.events ?? []).map(toEventItem);
  const turnItems = (conversation.turns ?? []).map((turn) => {
    const trace = traceById.get(turn.traceId);
    const turnDiagnostics = diagnostics.filter((diagnostic) => {
      if (diagnostic.turnId === turn.id || diagnostic.traceId === turn.traceId) {
        return true;
      }
      return Boolean(trace && diagnostic.eventId === trace.eventId);
    });
    return {
      type: "turn" as const,
      id: turn.id,
      at: turn.startedAt,
      traceId: turn.traceId,
      shortTraceId: shortId(turn.traceId),
      status: turn.status,
      fromSeq: turn.fromSeq,
      toSeq: turn.toSeq,
      eventSeqs: turn.eventSeqs ?? [],
      durationMs: durationMs(turn.startedAt, turn.endedAt),
      phases: turn.phases ?? [],
      actionNames: actionNames(turn.proposedActions),
      toolStatuses: toolStatuses(turn.toolResults),
      hasTrace: Boolean(trace),
      diagnostics: turnDiagnostics
    };
  });
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
  const traceIds = new Set((conversation.turns ?? []).map((turn) => turn.traceId));
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
    [...eventItems, ...windowItems, ...turnItems, ...loopExitItems],
    (item) => item.at
  );
  const lastEvent = conversation.events?.at(-1);
  const lastText = lastEvent?.event.message?.text;

  return {
    key,
    conversation: conversation.conversation,
    nextSeq: conversation.nextSeq,
    eventCount: conversation.events?.length ?? 0,
    windowCount: conversation.windows?.length ?? 0,
    turnCount: conversation.turns?.length ?? 0,
    loopExitCount: conversation.loopExits?.length ?? 0,
    selfMessageCount: (conversation.events ?? []).filter((event) =>
      Boolean(event.event.sender?.isSelf)
    ).length,
    ...(lastEvent ? { lastAt: lastEvent.receivedAt } : {}),
    ...(lastText ? { lastText: truncate(lastText, 140) } : {}),
    diagnostics: conversationDiagnostics,
    timeline
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
    ...(record.event.message?.id ? { messageId: record.event.message.id } : {}),
    ...(record.event.sender?.id ? { senderId: record.event.sender.id } : {}),
    ...(record.event.sender?.displayName
      ? { senderName: record.event.sender.displayName }
      : {}),
    isSelf: Boolean(record.event.sender?.isSelf),
    mentionsBot: Boolean(record.event.message?.mentionsBot),
    text: truncate(record.event.message?.text ?? record.event.type ?? "(no text)", 360),
    ...(sourceLabel ? { source: sourceLabel } : {})
  };
}

function summarizeTrace(trace: AgentTurnTrace, diagnostics: Diagnostic[]): TraceSummary {
  const actionList = actionNames(trace.proposedActions);
  const statuses = toolStatuses(trace.toolResults);
  const status = traceStatus(trace, diagnostics);
  const model = readTraceModel(trace);
  return {
    id: trace.id,
    shortId: shortId(trace.id),
    eventId: trace.eventId,
    startedAt: trace.startedAt,
    endedAt: trace.endedAt,
    durationMs: durationMs(trace.startedAt, trace.endedAt),
    status,
    spanCount: trace.spans?.length ?? 0,
    observationCount: trace.observations?.length ?? 0,
    actionNames: actionList,
    toolStatuses: statuses,
    ...(model ? { model } : {}),
    diagnostics
  };
}

function buildWaterfall(trace: AgentTurnTrace): WaterfallSpan[] {
  const startedAt = Date.parse(trace.startedAt);
  const total = Math.max(1, durationMs(trace.startedAt, trace.endedAt));
  const spanRows = (trace.spans ?? []).map((span) =>
    waterfallItem({
      id: span.id,
      name: span.name,
      type: "span",
      startedAt: span.startedAt,
      endedAt: span.endedAt,
      ...(readString(asRecord(span.attributes).status) === "error" ? { level: "ERROR" } : {}),
      traceStartedAt: startedAt,
      total
    })
  );
  const observationRows = (trace.observations ?? [])
    .filter((observation) => observation.type !== "span")
    .map((observation) =>
      waterfallItem({
        id: observation.id,
        name: observation.name,
        type: observation.type,
        startedAt: observation.startedAt ?? trace.startedAt,
        endedAt: observation.endedAt ?? observation.startedAt ?? trace.endedAt,
        ...(observation.level ? { level: observation.level } : {}),
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
  level?: string;
  traceStartedAt: number;
  total: number;
}): WaterfallSpan {
  const start = Date.parse(input.startedAt);
  const offset = Number.isFinite(start) ? Math.max(0, start - input.traceStartedAt) : 0;
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
    status: input.level === "ERROR" ? "error" : "ok",
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
  diagnostics: Diagnostic[]
): TraceSummary["status"] {
  if (
    diagnostics.some((diagnostic) => diagnostic.severity === "error") ||
    (trace.spans ?? []).some((span) => readString(asRecord(span.attributes).status) === "error") ||
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

function diagnosticsForTrace(traceId: string, diagnostics: Diagnostic[]): Diagnostic[] {
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
      const turn = turnItem?.type === "turn" ? findTurn(workspace, turnItem.id) : undefined;
      return {
        conversationKey: conversation.key,
        ...(turn ? { turn } : {}),
        ...(eventItem?.type === "event" ? { event: eventItem } : {})
      };
    }
  }
  return {};
}

function findTurn(workspace: TraceWorkspace, turnId: string): SessionTurnRecord | undefined {
  for (const conversation of workspace.conversations) {
    const turn = conversation.timeline.find(
      (item) => item.type === "turn" && item.id === turnId
    );
    if (!turn || turn.type !== "turn") {
      continue;
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
  return Array.from(new Set([...fromActions, ...fromToolObservations, ...readStringArray([])]));
}
