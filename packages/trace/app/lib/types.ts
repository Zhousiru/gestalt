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

export interface SessionSnapshot {
  version: number;
  exportedAt: string;
  conversations: ConversationSessionSnapshot[];
}

export interface Conversation {
  kind: string;
  id: string;
}

export interface ConversationSessionSnapshot {
  conversation: Conversation;
  nextSeq: number;
  events: SessionEventRecord[];
  windows: MessageWindow[];
  turns: SessionTurnRecord[];
  loopExits: AgentLoopExitRecord[];
}

export interface SessionEventRecord {
  seq: number;
  receivedAt: string;
  event: CanonicalEvent;
}

export interface CanonicalEvent {
  id: string;
  type: string;
  occurredAt?: string;
  source?: Record<string, unknown>;
  conversation: Conversation;
  sender?: {
    id?: string;
    displayName?: string;
    isSelf?: boolean;
  };
  message?: {
    id?: string;
    text?: string;
    rawText?: string;
    mentionsBot?: boolean;
  };
  raw?: unknown;
}

export interface MessageWindow {
  id: string;
  conversation: Conversation;
  reason: string;
  fromSeq: number;
  toSeq: number;
  eventSeqs: number[];
  closedAt: string;
}

export interface SessionTurnRecord {
  id: string;
  traceId: string;
  conversation: Conversation;
  status: string;
  startedAt: string;
  endedAt: string;
  windowIds: string[];
  fromSeq: number;
  toSeq: number;
  eventSeqs: number[];
  steerCount: number;
  phases: TurnPhaseRecord[];
  proposedActions: ActionProposal[];
  toolResults: unknown[];
}

export interface TurnPhaseRecord {
  phase: string;
  at: string;
}

export interface AgentLoopExitRecord {
  id: string;
  conversation: Conversation;
  triggerName: string;
  reason: string;
  description?: string;
  startedAt: string;
  endedAt: string;
  turnIds: string[];
  lastSeq?: number;
}

export interface ActionProposal {
  id?: string;
  proposedAt?: string;
  reason?: string;
  toolName?: string;
  params?: unknown;
}

export interface AgentTurnTrace {
  id: string;
  name: string;
  startedAt: string;
  endedAt: string;
  gestaltHome: string;
  eventId: string;
  personaVersion: string;
  spans: SpanRecord[];
  observations: ObservationRecord[];
  proposedActions: ActionProposal[];
  toolResults: unknown[];
}

export interface SpanRecord {
  id: string;
  traceId: string;
  parentSpanId?: string;
  name: string;
  startedAt: string;
  endedAt: string;
  attributes?: Record<string, unknown>;
}

export interface ObservationRecord {
  id: string;
  traceId: string;
  parentObservationId?: string;
  type: string;
  name: string;
  startedAt?: string;
  endedAt?: string;
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown>;
  model?: string;
  usage?: unknown;
  level?: string;
  statusMessage?: string;
}

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
  status: "ok" | "warning" | "error";
  spanCount: number;
  observationCount: number;
  actionNames: string[];
  toolStatuses: string[];
  model?: string;
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
  status: "ok" | "warning" | "error";
  kind: "span" | "generation" | "tool" | "agent" | "event" | "chain";
}

export interface TraceWorkspace {
  home: GestaltHomeView;
  generatedAt: string;
  sessionExportCount: number;
  traceCount: number;
  sessionFiles: string[];
  traceFiles: string[];
  latestSession?: {
    exportedAt: string;
    fileName: string;
    line: number;
  };
  conversations: ConversationView[];
  traces: TraceSummary[];
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
