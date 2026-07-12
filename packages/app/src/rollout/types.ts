export type JsonPrimitive = string | number | boolean | null;

export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

export type BinaryAvailability =
  | "stored"
  | "not_captured"
  | "size_limit_exceeded"
  | "write_failed";

export type BinaryWriteErrorCode =
  | "blob_directory_unavailable"
  | "blob_write_failed"
  | "blob_integrity_failed";

/**
 * The only binary representation permitted in a rollout JSONL record.
 *
 * `sha256` is the blob identity. Deliberately do not add a filesystem path or
 * source URL here: consumers resolve stored blobs through the trace blob API.
 */
export interface BinaryDescriptor {
  type: "binary";
  mediaType: string;
  byteLength: number;
  sha256: string;
  availability: BinaryAvailability;
  errorCode?: BinaryWriteErrorCode;
}

export type RolloutTerminalStatus = "completed" | "failed" | "cancelled";
export type GenerationStatus = "completed" | "failed" | "cancelled";
export type OperationStatus = "succeeded" | "failed" | "cancelled";

export interface RolloutMessage {
  id: string;
  role: string;
  content: unknown;
  name?: string;
  toolCallId?: string;
  metadata?: unknown;
}

interface RolloutRecordBase {
  id: string;
  rolloutId: string;
  timestamp: string;
}

export interface RolloutStartedRecord extends RolloutRecordBase {
  type: "rollout_started";
  activeLoopId: string;
  eventId?: string;
  conversationKey?: string;
  name?: string;
  metadata?: unknown;
}

export interface ModelSessionInitializedRecord extends RolloutRecordBase {
  type: "model_session_initialized";
  messages: RolloutMessage[];
  tools: unknown[];
  stateHash: string;
  provider?: string;
  model?: string;
  metadata?: unknown;
}

export type MessageCommitSource =
  | "user"
  | "assistant"
  | "tool"
  | "steer"
  | "dreaming";

export interface MessageCommittedRecord extends RolloutRecordBase {
  type: "message_committed";
  message: RolloutMessage;
  previousStateHash: string;
  stateHash: string;
  source?: MessageCommitSource;
  metadata?: unknown;
}

export interface GenerationCompletedRecord extends RolloutRecordBase {
  type: "generation_completed";
  generationId: string;
  inputStateHash: string;
  inputMessageCount: number;
  outputMessageIds: string[];
  status: GenerationStatus;
  provider?: string;
  model?: string;
  parameters?: unknown;
  finishReason?: string;
  usage?: unknown;
  cacheUsage?: unknown;
  latencyMs?: number;
  providerRequestId?: string;
  errorCode?: string;
  metadata?: unknown;
}

export interface ToolCompletedRecord extends RolloutRecordBase {
  type: "tool_completed";
  toolCallId: string;
  toolName: string;
  status: OperationStatus;
  startedAt?: string;
  durationMs?: number;
  input?: unknown;
  output?: unknown;
  errorCode?: string;
  metadata?: unknown;
}

export interface OutboundActionStartedRecord extends RolloutRecordBase {
  type: "outbound_action_started";
  actionId: string;
  toolName: string;
  params?: unknown;
  metadata?: unknown;
}

export interface OutboundActionFinishedRecord extends RolloutRecordBase {
  type: "outbound_action_finished";
  actionId: string;
  status: OperationStatus;
  durationMs?: number;
  result?: unknown;
  errorCode?: string;
  metadata?: unknown;
}

export interface SpanCompletedRecord extends RolloutRecordBase {
  type: "span_completed";
  spanId: string;
  parentSpanId?: string;
  name: string;
  startedAt: string;
  endedAt: string;
  status?: OperationStatus;
  attributes?: unknown;
}

export interface RolloutRecordCounts {
  recordCount: number;
  messageCount: number;
  generationCount: number;
  toolCount: number;
  outboundActionCount: number;
  unresolvedOutboundActionCount: number;
  spanCount: number;
}

export interface RolloutFinishedRecord extends RolloutRecordBase {
  type: "rollout_finished";
  status: RolloutTerminalStatus;
  reason?: string;
  summary: RolloutRecordCounts;
  metadata?: unknown;
}

/** Immutable records written to a rollout JSONL file. There is no version row. */
export type RolloutRecord =
  | RolloutStartedRecord
  | ModelSessionInitializedRecord
  | MessageCommittedRecord
  | GenerationCompletedRecord
  | ToolCompletedRecord
  | OutboundActionStartedRecord
  | OutboundActionFinishedRecord
  | SpanCompletedRecord
  | RolloutFinishedRecord;

export type RolloutRecordInput =
  | RolloutStartedRecord
  | (Omit<ModelSessionInitializedRecord, "stateHash"> & {
      stateHash?: string;
    })
  | (Omit<
      MessageCommittedRecord,
      "previousStateHash" | "stateHash"
    > & {
      previousStateHash?: string;
      stateHash?: string;
    })
  | (Omit<
      GenerationCompletedRecord,
      "inputStateHash" | "inputMessageCount"
    > & {
      inputStateHash?: string;
      inputMessageCount?: number;
    })
  | ToolCompletedRecord
  | OutboundActionStartedRecord
  | OutboundActionFinishedRecord
  | SpanCompletedRecord;

export interface RolloutCloseDetails {
  reason?: string;
  metadata?: unknown;
}

export interface RolloutWriter {
  readonly rolloutId: string;
  readonly filePath: string;
  readonly stateHash: string | undefined;
  readonly messageCount: number;
  append(record: RolloutRecordInput): Promise<void>;
  flush(options?: { durable?: boolean }): Promise<void>;
  close(
    status: RolloutTerminalStatus,
    details?: RolloutCloseDetails
  ): Promise<void>;
}

export interface RolloutQuery {
  cursor?: string;
  limit?: number;
  query?: string;
  status?: RolloutTerminalStatus;
}

export interface CursorPage<T> {
  items: T[];
  nextCursor?: string;
}

export interface RolloutSummary extends RolloutRecordCounts {
  id: string;
  activeLoopId: string;
  startedAt: string;
  endedAt?: string;
  status: RolloutTerminalStatus;
  failureReason?: string;
  eventId?: string;
  conversationKey?: string;
  name?: string;
  byteLength: number;
}

export interface UnresolvedOutboundAction {
  actionId: string;
  toolName: string;
  startedAt: string;
  status: "failed";
  reason:
    | "result_unknown_after_restart"
    | "result_unknown_after_dispatch";
}

export interface RolloutDetail {
  summary: RolloutSummary;
  records: RolloutRecord[];
  unresolvedOutboundActions: UnresolvedOutboundAction[];
  truncatedTail: boolean;
}

export interface ReconstructedInput {
  rolloutId: string;
  generationId: string;
  stateHash: string;
  messageCount: number;
  messages: RolloutMessage[];
  tools: unknown[];
}

export interface RolloutReader {
  list(query?: RolloutQuery): Promise<CursorPage<RolloutSummary>>;
  read(id: string): Promise<RolloutDetail>;
  reconstructInput(
    id: string,
    generationId: string
  ): Promise<ReconstructedInput>;
}
