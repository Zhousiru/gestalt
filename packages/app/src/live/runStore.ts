import type { Conversation } from "../events/schemas";
import type { LiveEventBus } from "./eventBus";
import type { ActiveRunView, RuntimeLiveEventEnvelope } from "./viewTypes";

export interface LiveRunStore {
  getActiveRuns(now?: () => Date): ActiveRunView[];
  getActiveRun(traceId: string, now?: () => Date): ActiveRunView | undefined;
  dispose(): void;
}

interface MutableRun extends ActiveRunView {}

const MAX_TRACKED_RUNS = 500;
const RUN_SUMMARY_TTL_MS = 24 * 60 * 60 * 1_000;

/**
 * Tracks only small active-rollout summaries. The event bus has already
 * discarded prompts, messages, spans, tool payloads, and binary content.
 */
export function createLiveRunStore(bus: LiveEventBus): LiveRunStore {
  const runs = new Map<string, MutableRun>();
  const unsubscribe = bus.subscribe({
    onEvent(event) {
      applyEvent(runs, event);
    }
  });

  return {
    getActiveRuns(now = () => new Date()) {
      pruneRuns(runs, now());
      return Array.from(runs.values())
        .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
        .map(copyRun);
    },

    getActiveRun(traceId, now = () => new Date()) {
      pruneRuns(runs, now());
      const run =
        runs.get(traceId) ??
        Array.from(runs.values()).find((candidate) =>
          candidate.traceId.startsWith(traceId)
        );
      return run ? copyRun(run) : undefined;
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
  pruneRuns(runs, event.at);
  const data = readRecord(event.data);
  const rolloutId = readRolloutId(data);
  if (!rolloutId) {
    return;
  }

  switch (event.type) {
    case "agent.run.started": {
      const conversation = parseConversationKey(readString(data, "conversationKey"));
      if (!conversation) {
        return;
      }
      const eventId = readString(data, "eventId");
      const existing = runs.get(rolloutId);
      if (existing) {
        existing.status = "running";
        existing.phase = "queued";
        existing.updatedAt = event.at;
        existing.messageCount += readCount(data, "messageCount");
        if (eventId) existing.eventId = eventId;
        break;
      }
      runs.set(rolloutId, {
        traceId: rolloutId,
        ...(eventId ? { eventId } : {}),
        conversation,
        startedAt: readString(data, "startedAt") ?? event.at,
        updatedAt: event.at,
        phase: readString(data, "phase") ?? "queued",
        status: "running",
        messageCount: readCount(data, "messageCount"),
        generationCount: 0,
        toolCount: 0,
        actionCount: 0
      });
      enforceRunLimit(runs);
      break;
    }

    case "agent.phase.changed": {
      const run = runs.get(rolloutId);
      if (!run) return;
      run.phase = readString(data, "phase") ?? readString(data, "status") ?? run.phase;
      run.updatedAt = event.at;
      break;
    }

    case "agent.observation.created": {
      const run = runs.get(rolloutId);
      if (!run) return;
      const observationType = readString(data, "observationType");
      if (observationType === "generation") run.generationCount += 1;
      if (observationType === "tool") run.toolCount += 1;
      run.updatedAt = event.at;
      break;
    }

    case "agent.run.completed": {
      const run = runs.get(rolloutId);
      if (!run) return;
      // A model turn completed, but the active loop/rollout may continue with
      // steering, waiting, or dreaming. rollout.recorded is terminal.
      run.status = "running";
      run.phase = "completed";
      run.updatedAt = event.at;
      run.actionCount += readCount(data, "actionCount");
      run.toolCount = Math.max(
        run.toolCount,
        readCount(data, "toolCount", run.toolCount)
      );
      break;
    }

    case "agent.run.failed": {
      const run = runs.get(rolloutId);
      if (!run) return;
      run.status = "failed";
      run.phase = "failed";
      run.updatedAt = event.at;
      const error = readString(data, "summary");
      if (error) run.error = error;
      break;
    }

    case "trace.recorded":
    case "rollout.recorded":
      runs.delete(rolloutId);
      break;

    case "agent.span.started":
    case "agent.span.ended": {
      const run = runs.get(rolloutId);
      if (run) run.updatedAt = event.at;
      break;
    }
  }
}

function pruneRuns(
  runs: Map<string, MutableRun>,
  now: Date | string
): void {
  const timestamp = now instanceof Date ? now.valueOf() : Date.parse(now);
  if (Number.isFinite(timestamp)) {
    for (const [id, run] of runs) {
      const updatedAt = Date.parse(run.updatedAt);
      if (
        Number.isFinite(updatedAt) &&
        timestamp - updatedAt > RUN_SUMMARY_TTL_MS
      ) {
        runs.delete(id);
      }
    }
  }
  enforceRunLimit(runs);
}

function enforceRunLimit(runs: Map<string, MutableRun>): void {
  if (runs.size <= MAX_TRACKED_RUNS) {
    return;
  }
  const oldest = [...runs.values()].sort(
    (left, right) =>
      left.updatedAt.localeCompare(right.updatedAt) ||
      left.traceId.localeCompare(right.traceId)
  );
  for (const run of oldest.slice(0, runs.size - MAX_TRACKED_RUNS)) {
    runs.delete(run.traceId);
  }
}

function copyRun(run: MutableRun): ActiveRunView {
  return { ...run, conversation: { ...run.conversation } };
}

function readRolloutId(data: Record<string, unknown>): string | undefined {
  const entity = readRecord(data.entity);
  return (
    readString(data, "rolloutId") ??
    readString(data, "traceId") ??
    (entity?.kind === "rollout" ? readString(entity, "id") : undefined)
  );
}

function parseConversationKey(value: string | undefined): Conversation | undefined {
  if (!value) return undefined;
  const separator = value.indexOf(":");
  const kind = value.slice(0, separator);
  const id = value.slice(separator + 1);
  return (kind === "group" || kind === "private") && id
    ? { kind, id }
    : undefined;
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(
  record: Record<string, unknown>,
  key: string
): string | undefined {
  const value = record[key];
  return typeof value === "string" && value ? value : undefined;
}

function readCount(
  record: Record<string, unknown>,
  key: string,
  fallback = 0
): number {
  const value = record[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : fallback;
}
