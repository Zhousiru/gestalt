import type { CanonicalEvent, Conversation } from "../events/schemas";
import type {
  AgentLoopExitRecord,
  ConversationSessionSnapshot,
  MessageWindow,
  SessionEventRecord,
  SessionSnapshot,
  SessionTurnRecord,
  TurnPhaseRecord
} from "../session/schemas";
import type { ActionProposal } from "../tools/schemas";
import type {
  AgentTurnTrace,
  ObservationRecord,
  SpanRecord
} from "../trace/schemas";

export interface GestaltHomeView {
  root: string;
  sessionsDir: string;
  tracesDir: string;
}

export interface JsonlEntry<T> {
  filePath: string;
  fileName: string;
  line: number;
  value: T;
}

export type {
  ActionProposal,
  AgentLoopExitRecord,
  AgentTurnTrace,
  CanonicalEvent,
  Conversation,
  ConversationSessionSnapshot,
  MessageWindow,
  ObservationRecord,
  SessionEventRecord,
  SessionSnapshot,
  SessionTurnRecord,
  SpanRecord,
  TurnPhaseRecord
};

export type DiagnosticSeverity = "info" | "warning" | "error";

export interface Diagnostic {
  id: string;
  severity: DiagnosticSeverity;
  code: string;
  title: string;
  message: string;
  at?: string;
  conversationKey?: string;
  traceId?: string;
  eventId?: string;
  turnId?: string;
}

export type TimelineItem =
  | EventTimelineItem
  | WindowTimelineItem
  | TurnTimelineItem
  | LoopExitTimelineItem;

export interface EventTimelineItem {
  type: "event";
  id: string;
  at: string;
  seq: number;
  eventId: string;
  messageId?: string;
  senderId?: string;
  senderName?: string;
  isSelf: boolean;
  mentionsBot: boolean;
  text: string;
  source?: string;
}

export interface WindowTimelineItem {
  type: "window";
  id: string;
  at: string;
  reason: string;
  fromSeq: number;
  toSeq: number;
  eventSeqs: number[];
}

export interface TurnTimelineItem {
  type: "turn";
  id: string;
  at: string;
  traceId: string;
  shortTraceId: string;
  status: string;
  fromSeq: number;
  toSeq: number;
  eventSeqs: number[];
  durationMs: number;
  phases: TurnPhaseRecord[];
  actionNames: string[];
  toolStatuses: string[];
  hasTrace: boolean;
  isActive: boolean;
  diagnostics: Diagnostic[];
}

export interface LoopExitTimelineItem {
  type: "loopExit";
  id: string;
  at: string;
  triggerName: string;
  reason: string;
  description?: string;
  turnIds: string[];
}

export interface ConversationView {
  key: string;
  conversation: Conversation;
  nextSeq: number;
  eventCount: number;
  windowCount: number;
  turnCount: number;
  loopExitCount: number;
  selfMessageCount: number;
  lastAt?: string;
  lastText?: string;
  diagnostics: Diagnostic[];
  timeline: TimelineItem[];
}

export interface TraceSummary {
  id: string;
  shortId: string;
  eventId: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  status: "ok" | "warning" | "error" | "running";
  spanCount: number;
  observationCount: number;
  actionNames: string[];
  toolStatuses: string[];
  model?: string;
  phase?: string;
  diagnostics: Diagnostic[];
}

export interface WaterfallSpan {
  id: string;
  name: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  offsetPct: number;
  widthPct: number;
  status: "ok" | "warning" | "error" | "running";
  kind: "span" | "generation" | "tool" | "agent" | "event" | "chain";
}

export interface ActiveRunView {
  traceId: string;
  shortTraceId: string;
  eventId: string;
  conversation: Conversation;
  window: MessageWindow;
  eventRecords: SessionEventRecord[];
  startedAt: string;
  updatedAt: string;
  phase: string;
  status: "running" | "completed" | "failed";
  phases: TurnPhaseRecord[];
  trace: AgentTurnTrace;
  error?: string;
}

export interface TraceWorkspace {
  home: GestaltHomeView;
  generatedAt: string;
  sessionExportCount: number;
  traceCount: number;
  activeRunCount: number;
  sessionFiles: string[];
  traceFiles: string[];
  latestSession?: {
    exportedAt: string;
    fileName: string;
    line: number;
  };
  conversations: ConversationView[];
  traces: TraceSummary[];
  activeRuns: ActiveRunView[];
  diagnostics: Diagnostic[];
}

export interface TraceDetail {
  workspace: Omit<TraceWorkspace, "conversations" | "traces">;
  summary: TraceSummary;
  trace: AgentTurnTrace;
  waterfall: WaterfallSpan[];
  relatedConversation?: string;
  relatedTurn?: SessionTurnRecord;
  relatedEvent?: EventTimelineItem;
  diagnostics: Diagnostic[];
}

export type RuntimeLiveEventType =
  | "live.ready"
  | "live.heartbeat"
  | "session.event.appended"
  | "session.window.created"
  | "session.turn.recorded"
  | "session.loop_exit.recorded"
  | "session.snapshot.changed"
  | "agent.run.started"
  | "agent.phase.changed"
  | "agent.span.started"
  | "agent.span.ended"
  | "agent.observation.created"
  | "agent.run.completed"
  | "agent.run.failed"
  | "trace.recorded";

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

export interface AgentRunStartedData {
  traceId: string;
  eventId: string;
  startedAt: string;
  gestaltHome: string;
  personaVersion: string;
  window: MessageWindow;
  eventRecords: SessionEventRecord[];
}

export interface AgentPhaseChangedData {
  traceId: string;
  phase: string;
  at: string;
}

export interface AgentSpanStartedData {
  traceId: string;
  spanId: string;
  name: string;
  startedAt: string;
  attributes: Record<string, unknown>;
}

export interface AgentSpanEndedData {
  traceId: string;
  span: SpanRecord;
}

export interface AgentObservationCreatedData {
  traceId: string;
  observation: ObservationRecord;
}

export interface AgentRunCompletedData {
  traceId: string;
  endedAt: string;
  proposedActions: ActionProposal[];
  toolResults: unknown[];
  trace: AgentTurnTrace;
}

export interface AgentRunFailedData {
  traceId: string;
  endedAt: string;
  error: string;
  trace: AgentTurnTrace;
}
