import { z } from "zod";

export const ScenarioModelSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("mock"),
      delayMs: z.number().int().nonnegative().optional()
    })
    .strict(),
  z
    .object({
      kind: z.literal("configured_ai_sdk")
    })
    .strict()
]);

export const ScenarioDreamingSchema = z
  .object({
    kind: z
      .enum(["disabled", "mock_bash_memory", "configured_bash_memory"])
      .default("disabled")
  })
  .strict()
  .default({ kind: "disabled" });

export const ScenarioMessageSchema = z
  .object({
    delayMs: z.number().int().nonnegative().default(0),
    waitForModelRequestCount: z.number().int().positive().optional(),
    conversationId: z.string().min(1),
    conversationName: z.string().min(1).optional(),
    senderId: z.string().min(1),
    senderName: z.string().min(1).optional(),
    messageId: z.string().min(1).optional(),
    text: z.string(),
    replyToMessageId: z.string().min(1).optional(),
    mentionsBot: z.boolean().default(false),
    windowReason: z
      .enum([
        "manual",
        "mock",
        "mention",
        "keyword",
        "activity",
        "icebreaker",
        "reply_to_bot",
        "steer",
        "replay"
      ])
      .default("manual")
  })
  .strict();

export const ScenarioSessionExpectationsSchema = z
  .object({
    conversations: z.number().int().positive().optional(),
    events: z.number().int().nonnegative().optional(),
    selfMessages: z.number().int().nonnegative().optional(),
    windows: z.number().int().nonnegative().optional(),
    turns: z.number().int().nonnegative().optional(),
    turnStatus: z.enum(["completed", "cancelled", "failed"]).optional(),
    steerCount: z.number().int().nonnegative().optional(),
    steerCounts: z.array(z.number().int().nonnegative()).optional(),
    eventIds: z.array(z.string().min(1)).optional(),
    turnEventIds: z.array(z.array(z.string().min(1))).optional(),
    windowReasons: z.array(z.string().min(1)).optional(),
    windowEventIds: z.array(z.array(z.string().min(1))).optional(),
    triggerAttempts: z.number().int().nonnegative().optional(),
    triggerAttemptReasons: z.array(z.string().min(1)).optional(),
    triggerAttemptProbabilities: z.array(z.number().min(0).max(1)).optional(),
    triggerAttemptAdmissions: z.array(z.boolean()).optional(),
    loopExits: z.number().int().nonnegative().optional(),
    loopExitReasons: z.array(z.string().min(1)).optional(),
    phases: z.array(z.string().min(1)).optional(),
    journalRecords: z.number().int().nonnegative().optional(),
    minJournalRecords: z.number().int().nonnegative().optional()
  })
  .strict();

export const ScenarioActionExpectationsSchema = z
  .object({
    toolName: z
      .enum([
        "say_nothing",
        "send_group_message",
        "send_dm",
        "send_image",
        "search_sticker",
        "send_sticker",
        "react_to_message",
        "leave"
      ])
      .optional(),
    toolNames: z.array(z.string().min(1)).optional(),
    toolNamesInclude: z.array(z.string().min(1)).optional(),
    groupId: z.string().min(1).optional(),
    textMaxLength: z.number().int().positive().optional(),
    textMinLength: z.number().int().nonnegative().optional(),
    textDoesNotMatch: z.string().min(1).optional()
  })
  .strict();

export const ScenarioToolExpectationsSchema = z
  .object({
    calls: z.number().int().nonnegative().optional(),
    toolNames: z.array(z.string().min(1)).optional(),
    toolNamesInclude: z.array(z.string().min(1)).optional(),
    connectorSideEffects: z.number().int().nonnegative().optional()
  })
  .strict();

export const ScenarioModelInputExpectationsSchema = z
  .object({
    requests: z.number().int().nonnegative().optional(),
    contains: z.array(z.string().min(1)).optional(),
    doesNotContain: z.array(z.string().min(1)).optional(),
    tools: z.array(z.string().min(1)).optional()
  })
  .strict();

export const ScenarioModelExchangeExpectationsSchema = z
  .object({
    exchanges: z.number().int().nonnegative().optional(),
    minExchanges: z.number().int().nonnegative().optional(),
    responses: z.number().int().nonnegative().optional(),
    minResponses: z.number().int().nonnegative().optional(),
    maxToolCallsPerResponse: z.number().int().nonnegative().optional(),
    purposes: z.array(z.enum(["agent_action", "dreaming"])).optional(),
    purposeIncludes: z.array(z.enum(["agent_action", "dreaming"])).optional(),
    responseContains: z.array(z.string().min(1)).optional(),
    responseDoesNotContain: z.array(z.string().min(1)).optional()
  })
  .strict();

export const ScenarioPromptCacheExpectationsSchema = z
  .object({
    enabled: z.boolean().optional(),
    appendOnly: z.boolean().optional(),
    singleSession: z.boolean().optional(),
    singleSystemMessage: z.boolean().optional(),
    requestBodyEnabled: z.boolean().optional(),
    includeDreaming: z.boolean().optional(),
    terminalDreamingContinuation: z.boolean().optional(),
    minHitResponses: z.number().int().nonnegative().optional(),
    minReadTokens: z.number().int().nonnegative().optional(),
    minFirstDreamingReadTokens: z.number().int().nonnegative().optional(),
    minDreamingHitResponses: z.number().int().nonnegative().optional(),
    minDreamingReadTokens: z.number().int().nonnegative().optional()
  })
  .strict();

export const ScenarioRolloutExpectationsSchema = z
  .object({
    rollouts: z.number().int().nonnegative().optional(),
    recordTypes: z.array(z.string().min(1)).optional(),
    spans: z.array(z.string().min(1)).optional(),
    toolNames: z.array(z.string().min(1)).optional(),
    toolNamesInclude: z.array(z.string().min(1)).optional(),
    modelResponseContains: z.array(z.string().min(1)).optional(),
    modelResponseDoesNotContain: z.array(z.string().min(1)).optional()
  })
  .strict();

export const ScenarioMemoryFileExpectationSchema = z
  .object({
    path: z.string().min(1),
    contains: z.string().min(1)
  })
  .strict();

export const ScenarioMemoryExpectationsSchema = z
  .object({
    homeBeforeContains: z
      .array(ScenarioMemoryFileExpectationSchema)
      .optional(),
    homeAfterContains: z
      .array(ScenarioMemoryFileExpectationSchema)
      .optional(),
    homeAfterDoesNotContain: z
      .array(ScenarioMemoryFileExpectationSchema)
      .optional(),
    injectedMemoryPaths: z.array(z.string().min(1)).optional(),
    injectedMemoryContains: z.array(z.string().min(1)).optional(),
    dreamCommandsContain: z.array(z.string().min(1)).optional(),
    dreamAddedFiles: z.array(z.string().min(1)).optional(),
    dreamChangedFiles: z.array(z.string().min(1)).optional()
  })
  .strict();

export const ScenarioExpectationsSchema = z
  .object({
    session: ScenarioSessionExpectationsSchema.optional(),
    action: ScenarioActionExpectationsSchema.optional(),
    tools: ScenarioToolExpectationsSchema.optional(),
    modelInput: ScenarioModelInputExpectationsSchema.optional(),
    modelExchange: ScenarioModelExchangeExpectationsSchema.optional(),
    promptCache: ScenarioPromptCacheExpectationsSchema.optional(),
    rollout: ScenarioRolloutExpectationsSchema.optional(),
    memory: ScenarioMemoryExpectationsSchema.optional()
  })
  .strict();

export const ScenarioFixtureSchema = z
  .object({
    id: z.string().min(1),
    description: z.string().min(1),
    now: z.string().datetime().optional(),
    homeFixture: z.string().min(1).optional(),
    configFixture: z.string().min(1).optional(),
    personaFixture: z.string().min(1).optional(),
    memoriesFixture: z.string().min(1).optional(),
    sessionJournalFixture: z.string().min(1).optional(),
    eventHandling: z
      .enum(["manual_windows", "runtime_triggers"])
      .default("manual_windows"),
    model: ScenarioModelSchema,
    dreaming: ScenarioDreamingSchema,
    events: z.array(ScenarioMessageSchema).min(1),
    expectations: ScenarioExpectationsSchema.default({})
  })
  .strict();

export type ScenarioFixture = z.infer<typeof ScenarioFixtureSchema>;
export type ScenarioMessage = z.infer<typeof ScenarioMessageSchema>;
