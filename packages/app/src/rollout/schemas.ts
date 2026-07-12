import { z } from "zod";
import type { RolloutRecord, RolloutRecordInput } from "./types";

const TimestampSchema = z.string().min(1).refine(
  (value) => Number.isFinite(Date.parse(value)),
  "Expected an ISO-compatible timestamp."
);
const StateHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const IdSchema = z.string().min(1);
const NonNegativeIntegerSchema = z.number().int().nonnegative();
const NonNegativeNumberSchema = z.number().finite().nonnegative();

const RecordBaseShape = {
  id: IdSchema,
  rolloutId: IdSchema,
  timestamp: TimestampSchema
};

export const RolloutMessageSchema = z
  .object({
    id: IdSchema,
    role: z.string().min(1),
    content: z.unknown(),
    name: z.string().min(1).optional(),
    toolCallId: z.string().min(1).optional(),
    metadata: z.unknown().optional()
  })
  .strict();

const RolloutStartedSchema = z
  .object({
    ...RecordBaseShape,
    type: z.literal("rollout_started"),
    activeLoopId: IdSchema,
    eventId: IdSchema.optional(),
    conversationKey: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    metadata: z.unknown().optional()
  })
  .strict();

const ModelSessionInitializedSchema = z
  .object({
    ...RecordBaseShape,
    type: z.literal("model_session_initialized"),
    messages: z.array(RolloutMessageSchema),
    tools: z.array(z.unknown()),
    stateHash: StateHashSchema,
    provider: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    metadata: z.unknown().optional()
  })
  .strict();

const MessageCommittedSchema = z
  .object({
    ...RecordBaseShape,
    type: z.literal("message_committed"),
    message: RolloutMessageSchema,
    previousStateHash: StateHashSchema,
    stateHash: StateHashSchema,
    source: z
      .enum(["user", "assistant", "tool", "steer", "dreaming"])
      .optional(),
    metadata: z.unknown().optional()
  })
  .strict();

const GenerationCompletedSchema = z
  .object({
    ...RecordBaseShape,
    type: z.literal("generation_completed"),
    generationId: IdSchema,
    inputStateHash: StateHashSchema,
    inputMessageCount: NonNegativeIntegerSchema,
    outputMessageIds: z.array(IdSchema),
    status: z.enum(["completed", "failed", "cancelled"]),
    provider: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    parameters: z.unknown().optional(),
    finishReason: z.string().min(1).optional(),
    usage: z.unknown().optional(),
    cacheUsage: z.unknown().optional(),
    latencyMs: NonNegativeNumberSchema.optional(),
    providerRequestId: z.string().min(1).optional(),
    errorCode: z.string().min(1).optional(),
    metadata: z.unknown().optional()
  })
  .strict();

const ToolCompletedSchema = z
  .object({
    ...RecordBaseShape,
    type: z.literal("tool_completed"),
    toolCallId: IdSchema,
    toolName: z.string().min(1),
    status: z.enum(["succeeded", "failed", "cancelled"]),
    startedAt: TimestampSchema.optional(),
    durationMs: NonNegativeNumberSchema.optional(),
    input: z.unknown().optional(),
    output: z.unknown().optional(),
    errorCode: z.string().min(1).optional(),
    metadata: z.unknown().optional()
  })
  .strict();

const OutboundActionStartedSchema = z
  .object({
    ...RecordBaseShape,
    type: z.literal("outbound_action_started"),
    actionId: IdSchema,
    toolName: z.string().min(1),
    params: z.unknown().optional(),
    metadata: z.unknown().optional()
  })
  .strict();

const OutboundActionFinishedSchema = z
  .object({
    ...RecordBaseShape,
    type: z.literal("outbound_action_finished"),
    actionId: IdSchema,
    status: z.enum(["succeeded", "failed", "cancelled"]),
    durationMs: NonNegativeNumberSchema.optional(),
    result: z.unknown().optional(),
    errorCode: z.string().min(1).optional(),
    metadata: z.unknown().optional()
  })
  .strict();

const SpanCompletedSchema = z
  .object({
    ...RecordBaseShape,
    type: z.literal("span_completed"),
    spanId: IdSchema,
    parentSpanId: IdSchema.optional(),
    name: z.string().min(1),
    startedAt: TimestampSchema,
    endedAt: TimestampSchema,
    status: z.enum(["succeeded", "failed", "cancelled"]).optional(),
    attributes: z.unknown().optional()
  })
  .strict();

export const RolloutRecordCountsSchema = z
  .object({
    recordCount: NonNegativeIntegerSchema,
    messageCount: NonNegativeIntegerSchema,
    generationCount: NonNegativeIntegerSchema,
    toolCount: NonNegativeIntegerSchema,
    outboundActionCount: NonNegativeIntegerSchema,
    unresolvedOutboundActionCount: NonNegativeIntegerSchema,
    spanCount: NonNegativeIntegerSchema
  })
  .strict();

const RolloutFinishedSchema = z
  .object({
    ...RecordBaseShape,
    type: z.literal("rollout_finished"),
    status: z.enum(["completed", "failed", "cancelled"]),
    reason: z.string().min(1).optional(),
    summary: RolloutRecordCountsSchema,
    metadata: z.unknown().optional()
  })
  .strict();

export const RolloutRecordSchema = z.discriminatedUnion("type", [
  RolloutStartedSchema,
  ModelSessionInitializedSchema,
  MessageCommittedSchema,
  GenerationCompletedSchema,
  ToolCompletedSchema,
  OutboundActionStartedSchema,
  OutboundActionFinishedSchema,
  SpanCompletedSchema,
  RolloutFinishedSchema
]);

const ModelSessionInitializedInputSchema = ModelSessionInitializedSchema.extend({
  stateHash: StateHashSchema.optional()
});
const MessageCommittedInputSchema = MessageCommittedSchema.extend({
  previousStateHash: StateHashSchema.optional(),
  stateHash: StateHashSchema.optional()
});
const GenerationCompletedInputSchema = GenerationCompletedSchema.extend({
  inputStateHash: StateHashSchema.optional(),
  inputMessageCount: NonNegativeIntegerSchema.optional()
});

export const RolloutRecordInputSchema = z.discriminatedUnion("type", [
  RolloutStartedSchema,
  ModelSessionInitializedInputSchema,
  MessageCommittedInputSchema,
  GenerationCompletedInputSchema,
  ToolCompletedSchema,
  OutboundActionStartedSchema,
  OutboundActionFinishedSchema,
  SpanCompletedSchema
]);

export function parseRolloutRecord(value: unknown): RolloutRecord {
  return RolloutRecordSchema.parse(value) as RolloutRecord;
}

export function parseRolloutRecordInput(value: unknown): RolloutRecordInput {
  return RolloutRecordInputSchema.parse(value) as RolloutRecordInput;
}
