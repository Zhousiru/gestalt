import type { Conversation } from "../events/schemas";

export interface JsonlEntry<T> {
  filePath: string;
  fileName: string;
  line: number;
  value: T;
}

/** Small in-memory summary; persistent detail is always read from a rollout. */
export interface ActiveRunView {
  traceId: string;
  eventId?: string;
  conversation: Conversation;
  startedAt: string;
  updatedAt: string;
  phase: string;
  status: "running" | "completed" | "failed";
  messageCount: number;
  generationCount: number;
  toolCount: number;
  actionCount: number;
  error?: string;
}

export type RuntimeLiveEventType =
  | "live.ready"
  | "live.heartbeat"
  | "session.event.appended"
  | "session.trigger_attempt.recorded"
  | "session.window.created"
  | "session.turn.recorded"
  | "session.loop_exit.recorded"
  | "agent.run.started"
  | "agent.phase.changed"
  | "agent.span.started"
  | "agent.span.ended"
  | "agent.observation.created"
  | "agent.run.completed"
  | "agent.run.failed"
  | "trace.recorded"
  | "rollout.recorded"
  | "sticker.scraping.state_changed"
  | "sticker.job.updated"
  | "sticker.catalog.updated"
  | "sticker.index.updated"
  | "sticker.search.completed"
  | "sticker.send.completed";

export interface RuntimeLiveEventEnvelope<T = unknown> {
  id: number;
  type: RuntimeLiveEventType;
  at: string;
  data: T;
}

export interface LiveEventSink {
  publish<T>(
    type: RuntimeLiveEventType,
    data: T,
    at?: string
  ): RuntimeLiveEventEnvelope<T>;
}
