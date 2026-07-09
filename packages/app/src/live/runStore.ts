import type { LiveEventBus } from "./eventBus";
import { shortId } from "./format";
import type {
  ActionProposal,
  ActiveRunView,
  AgentObservationCreatedData,
  AgentPhaseChangedData,
  AgentRunCompletedData,
  AgentRunFailedData,
  AgentRunStartedData,
  AgentSpanEndedData,
  AgentSpanStartedData,
  AgentTurnTrace,
  MessageWindow,
  ObservationRecord,
  RuntimeLiveEventEnvelope,
  SessionEventRecord,
  SpanRecord,
  TurnPhaseRecord
} from "./viewTypes";

export interface LiveRunStore {
  getActiveRuns(now?: () => Date): ActiveRunView[];
  getActiveRun(traceId: string, now?: () => Date): ActiveRunView | undefined;
  dispose(): void;
}

interface MutableRun {
  traceId: string;
  eventId: string;
  conversation: ActiveRunView["conversation"];
  window: MessageWindow;
  eventRecords: SessionEventRecord[];
  startedAt: string;
  endedAt?: string;
  updatedAt: string;
  phase: string;
  status: ActiveRunView["status"];
  phases: TurnPhaseRecord[];
  gestaltHome: string;
  personaVersion: string;
  spanOrder: string[];
  spans: Map<string, SpanRecord>;
  observations: ObservationRecord[];
  proposedActions: ActionProposal[];
  toolResults: unknown[];
  error?: string;
}

export function createLiveRunStore(bus: LiveEventBus): LiveRunStore {
  const runs = new Map<string, MutableRun>();
  const unsubscribe = bus.subscribe({
    onEvent(event) {
      applyEvent(runs, event);
    }
  });

  return {
    getActiveRuns(now = () => new Date()) {
      const at = now().toISOString();
      return Array.from(runs.values())
        .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))
        .map((run) => toActiveRunView(run, at));
    },

    getActiveRun(traceId, now = () => new Date()) {
      const run =
        runs.get(traceId) ??
        Array.from(runs.values()).find((candidate) =>
          candidate.traceId.startsWith(traceId)
        );
      return run ? toActiveRunView(run, now().toISOString()) : undefined;
    },

    dispose() {
      unsubscribe();
      runs.clear();
    }
  };
}

function applyEvent(
  runs: Map<string, MutableRun>,
  event: RuntimeLiveEventEnvelope
): void {
  switch (event.type) {
    case "agent.run.started": {
      const data = event.data as AgentRunStartedData;
      runs.set(data.traceId, {
        traceId: data.traceId,
        eventId: data.eventId,
        conversation: data.window.conversation,
        window: data.window,
        eventRecords: data.eventRecords,
        startedAt: data.startedAt,
        updatedAt: event.at,
        phase: "queued",
        status: "running",
        phases: [],
        gestaltHome: data.gestaltHome,
        personaVersion: data.personaVersion,
        spanOrder: [],
        spans: new Map(),
        observations: [],
        proposedActions: [],
        toolResults: []
      });
      break;
    }

    case "agent.phase.changed": {
      const data = event.data as AgentPhaseChangedData;
      const run = runs.get(data.traceId);
      if (!run) {
        break;
      }
      run.phase = data.phase;
      run.updatedAt = event.at;
      run.phases.push({
        phase: data.phase as TurnPhaseRecord["phase"],
        at: data.at
      });
      break;
    }

    case "agent.span.started": {
      const data = event.data as AgentSpanStartedData;
      const run = runs.get(data.traceId);
      if (!run) {
        break;
      }
      if (!run.spans.has(data.spanId)) {
        run.spanOrder.push(data.spanId);
      }
      run.spans.set(data.spanId, {
        id: data.spanId,
        traceId: data.traceId,
        name: data.name,
        startedAt: data.startedAt,
        endedAt: data.startedAt,
        attributes: {
          ...data.attributes,
          status: "running"
        }
      });
      run.updatedAt = event.at;
      break;
    }

    case "agent.span.ended": {
      const data = event.data as AgentSpanEndedData;
      const run = runs.get(data.traceId);
      if (!run) {
        break;
      }
      if (!run.spans.has(data.span.id)) {
        run.spanOrder.push(data.span.id);
      }
      run.spans.set(data.span.id, data.span);
      run.updatedAt = event.at;
      break;
    }

    case "agent.observation.created": {
      const data = event.data as AgentObservationCreatedData;
      const run = runs.get(data.traceId);
      if (!run) {
        break;
      }
      if (!run.observations.some((observation) => observation.id === data.observation.id)) {
        run.observations.push(data.observation);
      }
      run.updatedAt = event.at;
      break;
    }

    case "agent.run.completed": {
      const data = event.data as AgentRunCompletedData;
      const run = runs.get(data.traceId);
      if (!run) {
        break;
      }
      run.status = "completed";
      run.phase = "completed";
      run.endedAt = data.endedAt;
      run.updatedAt = event.at;
      run.proposedActions = data.proposedActions;
      run.toolResults = data.toolResults;
      run.spanOrder = data.trace.spans.map((span) => span.id);
      run.spans = new Map(data.trace.spans.map((span) => [span.id, span]));
      run.observations = [...data.trace.observations];
      break;
    }

    case "agent.run.failed": {
      const data = event.data as AgentRunFailedData;
      const run = runs.get(data.traceId);
      if (!run) {
        break;
      }
      run.status = "failed";
      run.phase = "failed";
      run.endedAt = data.endedAt;
      run.updatedAt = event.at;
      run.error = data.error;
      run.spanOrder = data.trace.spans.map((span) => span.id);
      run.spans = new Map(data.trace.spans.map((span) => [span.id, span]));
      run.observations = [...data.trace.observations];
      run.proposedActions = data.trace.proposedActions;
      run.toolResults = data.trace.toolResults;
      break;
    }

    case "trace.recorded": {
      const data = event.data as { traceId?: string };
      if (data.traceId) {
        runs.delete(data.traceId);
      }
      break;
    }
  }
}

function toActiveRunView(run: MutableRun, nowIso: string): ActiveRunView {
  return {
    traceId: run.traceId,
    shortTraceId: shortId(run.traceId),
    eventId: run.eventId,
    conversation: run.conversation,
    window: run.window,
    eventRecords: run.eventRecords,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    phase: run.phase,
    status: run.status,
    phases: run.phases,
    trace: toTrace(run, nowIso),
    ...(run.error ? { error: run.error } : {})
  };
}

function toTrace(run: MutableRun, nowIso: string): AgentTurnTrace {
  const endedAt =
    run.status === "running" ? nowIso : run.endedAt ?? run.updatedAt ?? nowIso;
  const spans = run.spanOrder
    .map((spanId) => run.spans.get(spanId))
    .filter((span): span is SpanRecord => Boolean(span))
    .map((span) =>
      span.attributes.status === "running"
        ? {
            ...span,
            endedAt,
            attributes: {
              ...span.attributes,
              status: "running"
            }
          }
        : span
    );

  return {
    id: run.traceId,
    name: "agent.turn",
    startedAt: run.startedAt,
    endedAt,
    gestaltHome: run.gestaltHome,
    eventId: run.eventId,
    personaVersion: run.personaVersion,
    spans,
    observations: [...run.observations],
    proposedActions: run.proposedActions,
    toolResults: run.toolResults
  };
}
