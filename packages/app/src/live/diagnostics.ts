import {
  asRecord,
  conversationKey,
  durationMs,
  jsonPreview,
  readString,
  shortId
} from "./format";
import type {
  AgentTurnTrace,
  ConversationSessionSnapshot,
  Diagnostic,
  SessionTurnRecord,
  TraceSummary
} from "./viewTypes";

export interface DiagnosticInput {
  conversations: ConversationSessionSnapshot[];
  traces: AgentTurnTrace[];
  traceSummaries: TraceSummary[];
  activeTraceIds?: Set<string>;
}

export function collectDiagnostics(input: DiagnosticInput): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const activeTraceIds = input.activeTraceIds ?? new Set<string>();
  const tracesByEvent = new Map<string, AgentTurnTrace[]>();
  const tracesById = new Map(input.traces.map((trace) => [trace.id, trace]));
  const turnsByTraceId = new Map<string, SessionTurnRecord>();

  for (const trace of input.traces) {
    const existing = tracesByEvent.get(trace.eventId) ?? [];
    existing.push(trace);
    tracesByEvent.set(trace.eventId, existing);
  }

  for (const conversation of input.conversations) {
    for (const turn of conversation.turns ?? []) {
      turnsByTraceId.set(turn.traceId, turn);
      if (!tracesById.has(turn.traceId) && !activeTraceIds.has(turn.traceId)) {
        diagnostics.push({
          id: `missing-trace:${turn.traceId}`,
          severity: "warning",
          code: "session_turn_without_trace",
          title: "Session turn has no trace",
          message: `Turn ${shortId(turn.id)} points to trace ${shortId(turn.traceId)}, but that trace is not present in GestaltHome traces.`,
          at: turn.startedAt,
          conversationKey: conversationKey(conversation.conversation),
          traceId: turn.traceId,
          turnId: turn.id
        });
      }
    }
  }

  for (const [eventId, traces] of tracesByEvent) {
    if (traces.length <= 1) {
      continue;
    }

    const first = traces[0];
    const traceList = traces.map((trace) => shortId(trace.id)).join(", ");
    diagnostics.push({
      id: `duplicate-event:${eventId}`,
      severity: "error",
      code: "duplicate_event_run",
      title: "Duplicate runs for one event",
      message: `${traces.length} traces processed event ${shortId(eventId, 18)}: ${traceList}.`,
      ...(first ? { at: first.startedAt, eventId } : {})
    });
    for (const trace of traces) {
      diagnostics.push({
        id: `duplicate-event:${eventId}:${trace.id}`,
        severity: "error",
        code: "duplicate_event_run",
        title: "Duplicate runs for one event",
        message: `Trace ${shortId(trace.id)} shares event ${shortId(eventId, 18)} with ${traces.length - 1} other run(s): ${traceList}.`,
        at: trace.startedAt,
        traceId: trace.id,
        eventId
      });
    }
  }

  for (const trace of input.traces) {
    if (!turnsByTraceId.has(trace.id) && !activeTraceIds.has(trace.id)) {
      diagnostics.push({
        id: `trace-without-turn:${trace.id}`,
        severity: "info",
        code: "trace_without_session_turn",
        title: "Trace has no session turn",
        message: `Trace ${shortId(trace.id)} is present on disk but is not referenced by the latest session snapshot.`,
        at: trace.startedAt,
        traceId: trace.id,
        eventId: trace.eventId
      });
    }

    const modelText = readModelStopText(trace);
    if ((trace.proposedActions?.length ?? 0) === 0 && modelText) {
      diagnostics.push({
        id: `silent-model-stop:${trace.id}`,
        severity: "warning",
        code: "silent_model_stop",
        title: "Model text was private",
        message: `Model produced "${modelText}" but no visible tool call was proposed.`,
        at: trace.endedAt,
        traceId: trace.id,
        eventId: trace.eventId
      });
    }

    const slowModelSpan = trace.spans?.find(
      (span) =>
        span.name === "model.decide" &&
        durationMs(span.startedAt, span.endedAt) > 20_000
    );
    if (slowModelSpan) {
      diagnostics.push({
        id: `long-model:${trace.id}`,
        severity: "warning",
        code: "long_model_decide",
        title: "Slow model span",
        message: `model.decide took ${durationMs(
          slowModelSpan.startedAt,
          slowModelSpan.endedAt
        )}ms in trace ${shortId(trace.id)}.`,
        at: slowModelSpan.endedAt,
        traceId: trace.id,
        eventId: trace.eventId
      });
    }

    for (const toolResult of trace.toolResults ?? []) {
      const result = asRecord(toolResult);
      const status = readString(result.status);
      if (status !== "failed") {
        continue;
      }

      diagnostics.push({
        id: `tool-failed:${trace.id}:${diagnostics.length}`,
        severity: "error",
        code: "tool_failed",
        title: "Tool failed",
        message: `A tool result failed in trace ${shortId(trace.id)}: ${jsonPreview(
          result.reason ?? result.result
        )}.`,
        at: readString(result.executedAt) ?? trace.endedAt,
        traceId: trace.id,
        eventId: trace.eventId
      });
    }

    for (const action of trace.proposedActions ?? []) {
      if (action.toolName !== "say_nothing") {
        continue;
      }

      diagnostics.push({
        id: `say-nothing:${trace.id}:${action.id ?? "action"}`,
        severity: "info",
        code: "say_nothing",
        title: "Silent action",
        message: action.reason
          ? `say_nothing: ${action.reason}`
          : `Trace ${shortId(trace.id)} intentionally stayed silent.`,
        at: action.proposedAt ?? trace.endedAt,
        traceId: trace.id,
        eventId: trace.eventId
      });
    }
  }

  return diagnostics.sort(
    (a, b) => normalizedDate(b.at) - normalizedDate(a.at)
  );
}

function readModelStopText(trace: AgentTurnTrace): string | undefined {
  for (const observation of trace.observations ?? []) {
    if (observation.type !== "generation") {
      continue;
    }
    const output = asRecord(observation.output);
    const finishReason =
      readString(output.finishReason) ??
      readString(asRecord(observation.metadata).finishReason);
    const content = readString(output.content);
    if (finishReason === "stop" && content) {
      return jsonPreview(content, 96);
    }
  }

  for (const span of trace.spans ?? []) {
    if (span.name !== "model.decide") {
      continue;
    }
    const responses = asRecord(span.attributes).modelResponses;
    if (!Array.isArray(responses)) {
      continue;
    }
    for (const response of responses) {
      const record = asRecord(response);
      if (readString(record.finishReason) === "stop") {
        const content = readString(record.content);
        if (content) {
          return jsonPreview(content, 96);
        }
      }
    }
  }

  return undefined;
}

function normalizedDate(value: string | undefined): number {
  const timestamp = Date.parse(value ?? "");
  return Number.isFinite(timestamp) ? timestamp : 0;
}
