import { z } from "zod";

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;

const idSchema = z.string().min(1);
const timestampSchema = z.string().min(1);
const nonNegativeIntSchema = z.number().int().nonnegative();

export const RolloutStatusSchema = z.enum([
  "running",
  "completed",
  "failed",
  "cancelled"
]);
export type RolloutStatus = z.infer<typeof RolloutStatusSchema>;

export const SignalSeveritySchema = z.enum(["info", "warning", "error"]);
export type SignalSeverity = z.infer<typeof SignalSeveritySchema>;

export const SignalCountsSchema = z
  .object({
    info: nonNegativeIntSchema,
    warning: nonNegativeIntSchema,
    error: nonNegativeIntSchema
  })
  .strict();
export type SignalCounts = z.infer<typeof SignalCountsSchema>;

export const LiveSignalSchema = z
  .object({
    id: idSchema,
    severity: SignalSeveritySchema,
    code: z.string().min(1),
    title: z.string().min(1),
    message: z.string(),
    at: timestampSchema.optional(),
    conversationKey: idSchema.optional(),
    rolloutId: idSchema.optional(),
    recordId: idSchema.optional()
  })
  .strict();
export type LiveSignal = z.infer<typeof LiveSignalSchema>;

export const LiveOverviewSchema = z
  .object({
    generatedAt: timestampSchema,
    counts: z
      .object({
        conversations: nonNegativeIntSchema,
        rollouts: nonNegativeIntSchema,
        rolloutsCapped: z.boolean(),
        activeRollouts: nonNegativeIntSchema,
        signals: nonNegativeIntSchema
      })
      .strict(),
    binaryCaptureEnabled: z.boolean(),
    latestActivityAt: timestampSchema.optional(),
    signals: z.array(LiveSignalSchema)
  })
  .strict();
export type LiveOverview = z.infer<typeof LiveOverviewSchema>;

export const ConversationSummarySchema = z
  .object({
    key: idSchema,
    kind: z.string().min(1),
    id: idSchema,
    name: z.string().min(1).optional(),
    lastAt: timestampSchema.optional(),
    lastText: z.string().optional(),
    messageCount: nonNegativeIntSchema,
    rolloutCount: nonNegativeIntSchema,
    signals: SignalCountsSchema
  })
  .strict();
export type ConversationSummary = z.infer<typeof ConversationSummarySchema>;

export const TimelineMessageSchema = z
  .object({
    type: z.literal("message"),
    id: idSchema,
    at: timestampSchema,
    eventId: idSchema,
    messageId: idSchema.optional(),
    senderId: idSchema.optional(),
    senderName: z.string().min(1).optional(),
    isSelf: z.boolean(),
    mentionsBot: z.boolean(),
    text: z.string(),
    source: z.string().min(1).optional()
  })
  .strict();

export const TimelineRolloutSchema = z
  .object({
    type: z.literal("rollout"),
    id: idSchema,
    at: timestampSchema,
    rolloutId: idSchema,
    status: RolloutStatusSchema,
    phase: z.string().min(1).optional(),
    durationMs: nonNegativeIntSchema.optional(),
    model: z.string().min(1).optional(),
    failureReason: z.string().optional()
  })
  .strict();

export const TimelineMarkerSchema = z
  .object({
    type: z.literal("marker"),
    id: idSchema,
    at: timestampSchema,
    label: z.string().min(1),
    detail: z.string().optional(),
    tone: z.enum(["neutral", "info", "warning", "error"]).optional()
  })
  .strict();

export const ConversationTimelineItemSchema = z.discriminatedUnion("type", [
  TimelineMessageSchema,
  TimelineRolloutSchema,
  TimelineMarkerSchema
]);
export type ConversationTimelineItem = z.infer<
  typeof ConversationTimelineItemSchema
>;

export const RolloutSummarySchema = z
  .object({
    id: idSchema,
    conversationKey: idSchema.optional(),
    status: RolloutStatusSchema,
    startedAt: timestampSchema,
    endedAt: timestampSchema.optional(),
    durationMs: nonNegativeIntSchema.optional(),
    model: z.string().min(1).optional(),
    phase: z.string().min(1).optional(),
    failureReason: z.string().optional(),
    generationCount: nonNegativeIntSchema,
    toolCount: nonNegativeIntSchema,
    actionCount: nonNegativeIntSchema,
    messageCount: nonNegativeIntSchema,
    signals: SignalCountsSchema
  })
  .strict();
export type RolloutSummary = z.infer<typeof RolloutSummarySchema>;

export const BinaryAvailabilitySchema = z.enum([
  "not_captured",
  "stored",
  "size_limit_exceeded",
  "write_failed"
]);
export type BinaryAvailability = z.infer<typeof BinaryAvailabilitySchema>;

export const BinaryErrorCodeSchema = z.enum([
  "blob_directory_unavailable",
  "blob_write_failed",
  "blob_integrity_failed"
]);
export type BinaryErrorCode = z.infer<typeof BinaryErrorCodeSchema>;

export const BinaryDescriptorSchema = z
  .object({
    type: z.literal("binary"),
    mediaType: z.string().min(1),
    byteLength: nonNegativeIntSchema,
    sha256: z.string().regex(/^[a-f0-9]{64}$/i),
    availability: BinaryAvailabilitySchema,
    errorCode: BinaryErrorCodeSchema.optional()
  })
  .strict();
export type BinaryDescriptor = z.infer<typeof BinaryDescriptorSchema>;

export const ModelMessageSchema = z
  .object({
    id: idSchema,
    role: z.string().min(1),
    content: z.unknown(),
    name: z.string().min(1).optional(),
    committedAt: timestampSchema.optional()
  })
  .strict();
export type ModelMessage = z.infer<typeof ModelMessageSchema>;

export const TokenUsageSchema = z
  .object({
    inputTokens: nonNegativeIntSchema.optional(),
    outputTokens: nonNegativeIntSchema.optional(),
    totalTokens: nonNegativeIntSchema.optional()
  })
  .strict();
export type TokenUsage = z.infer<typeof TokenUsageSchema>;

export const CacheUsageSchema = z
  .object({
    readInputTokens: nonNegativeIntSchema.optional(),
    writeInputTokens: nonNegativeIntSchema.optional(),
    prefixReused: z.boolean().optional()
  })
  .strict();
export type CacheUsage = z.infer<typeof CacheUsageSchema>;

export const GenerationSummarySchema = z
  .object({
    id: idSchema,
    completedAt: timestampSchema,
    inputStateHash: z.string().min(1),
    messageCount: nonNegativeIntSchema,
    outputMessageIds: z.array(idSchema),
    model: z.string().min(1).optional(),
    finishReason: z.string().optional(),
    latencyMs: nonNegativeIntSchema.optional(),
    providerRequestId: z.string().min(1).optional(),
    usage: TokenUsageSchema.optional(),
    cache: CacheUsageSchema.optional()
  })
  .strict();
export type GenerationSummary = z.infer<typeof GenerationSummarySchema>;

export const FlowItemSchema = z
  .object({
    id: idSchema,
    type: z.enum([
      "generation",
      "tool",
      "outbound_action",
      "dreaming",
      "span"
    ]),
    title: z.string().min(1),
    detail: z.string().optional(),
    status: z.enum(["running", "completed", "failed", "cancelled", "unknown"]),
    startedAt: timestampSchema,
    endedAt: timestampSchema.optional(),
    durationMs: nonNegativeIntSchema.optional(),
    parentId: idSchema.optional(),
    resultUnknownReason: z
      .enum(["process_restarted", "dispatch_response_lost"])
      .optional(),
    recordIds: z.array(idSchema)
  })
  .strict();
export type FlowItem = z.infer<typeof FlowItemSchema>;

export const RolloutRecordTypeSchema = z.enum([
  "rollout_started",
  "model_session_initialized",
  "message_committed",
  "generation_completed",
  "tool_completed",
  "outbound_action_started",
  "outbound_action_finished",
  "span_completed",
  "rollout_finished"
]);
export type RolloutRecordType = z.infer<typeof RolloutRecordTypeSchema>;

export const RolloutRecordViewSchema = z
  .object({
    id: idSchema,
    type: RolloutRecordTypeSchema,
    at: timestampSchema,
    stateHash: z.string().min(1).optional(),
    payload: z.unknown()
  })
  .strict();
export type RolloutRecordView = z.infer<typeof RolloutRecordViewSchema>;

export const RolloutDetailSchema = z
  .object({
    summary: RolloutSummarySchema,
    modelSession: z
      .object({
        initializedAt: timestampSchema.optional(),
        initialStateHash: z.string().min(1).optional(),
        initialMessageCount: nonNegativeIntSchema,
        toolCount: nonNegativeIntSchema,
        toolNames: z.array(z.string().min(1))
      })
      .strict(),
    generations: z.array(GenerationSummarySchema),
    flow: z.array(FlowItemSchema),
    records: z.array(RolloutRecordViewSchema),
    signals: z.array(LiveSignalSchema)
  })
  .strict();
export type RolloutDetail = z.infer<typeof RolloutDetailSchema>;

export const ModelInputViewSchema = z.enum(["delta", "full"]);
export type ModelInputView = z.infer<typeof ModelInputViewSchema>;

export const ModelInputResponseSchema = z
  .object({
    rolloutId: idSchema,
    generationId: idSchema,
    view: ModelInputViewSchema,
    stateHash: z.string().min(1),
    messageCount: nonNegativeIntSchema,
    messages: z.array(ModelMessageSchema),
    tools: z.array(z.unknown()).optional(),
    unavailableBinaryCount: nonNegativeIntSchema
  })
  .strict();
export type ModelInputResponse = z.infer<typeof ModelInputResponseSchema>;

export function cursorPageSchema<Item extends z.ZodType>(item: Item) {
  return z
    .object({
      items: z.array(item),
      nextCursor: z.string().min(1).optional()
    })
    .strict();
}

export const ConversationsPageSchema = cursorPageSchema(
  ConversationSummarySchema
);
export type ConversationsPage = z.infer<typeof ConversationsPageSchema>;

export const RolloutsPageSchema = cursorPageSchema(RolloutSummarySchema);
export type RolloutsPage = z.infer<typeof RolloutsPageSchema>;

export const ConversationTimelinePageSchema = z
  .object({
    conversation: ConversationSummarySchema,
    items: z.array(ConversationTimelineItemSchema),
    nextCursor: z.string().min(1).optional()
  })
  .strict();
export type ConversationTimelinePage = z.infer<
  typeof ConversationTimelinePageSchema
>;

export const LiveEventEnvelopeSchema = z
  .object({
    id: z.union([z.string().min(1), nonNegativeIntSchema]),
    type: z.string().min(1),
    at: timestampSchema,
    data: z
      .object({
        entity: z
          .object({
            kind: z.enum(["overview", "conversation", "rollout", "signal"]),
            id: z.string().min(1).optional()
          })
          .strict()
          .optional(),
        status: z.string().min(1).optional(),
        summary: z.string().optional()
      })
      .passthrough()
  })
  .strict();
export type LiveEventEnvelope = z.infer<typeof LiveEventEnvelopeSchema>;
