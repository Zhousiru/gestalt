import { z } from "zod";
import { CanonicalEventSchema, ConversationSchema } from "../events/schemas";
import { ActionProposalSchema } from "../tools/schemas";

export const MessageWindowReasonSchema = z.enum([
  "manual",
  "mock",
  "mention",
  "keyword",
  "activity",
  "icebreaker",
  "reply_to_bot",
  "steer",
  "replay"
]);

export const TurnPhaseSchema = z.enum([
  "queued",
  "memory_injecting",
  "context_compiling",
  "model_running",
  "executing",
  "steering",
  "completed",
  "cancelled",
  "failed"
]);

export const SessionEventRecordSchema = z
  .object({
    id: z.string().min(1),
    receivedAt: z.string().min(1),
    event: CanonicalEventSchema
  })
  .strict();

export const MessageWindowSchema = z
  .object({
    id: z.string().min(1),
    conversation: ConversationSchema,
    reason: MessageWindowReasonSchema,
    eventIds: z.array(z.string().min(1)).min(1),
    closedAt: z.string().min(1)
  })
  .strict();

export const TurnPhaseRecordSchema = z
  .object({
    phase: TurnPhaseSchema,
    at: z.string().min(1)
  })
  .strict();

export const SessionTurnRecordSchema = z
  .object({
    id: z.string().min(1),
    rolloutId: z.string().min(1),
    conversation: ConversationSchema,
    status: z.enum(["completed", "cancelled", "failed"]),
    startedAt: z.string().min(1),
    endedAt: z.string().min(1),
    windowIds: z.array(z.string().min(1)).min(1),
    eventIds: z.array(z.string().min(1)).min(1),
    steerCount: z.number().int().nonnegative(),
    phases: z.array(TurnPhaseRecordSchema),
    proposedActions: z.array(ActionProposalSchema),
    toolResults: z.array(z.unknown())
  })
  .strict();

export const AgentLoopExitRecordSchema = z
  .object({
    id: z.string().min(1),
    conversation: ConversationSchema,
    triggerName: z.string().min(1),
    reason: z.string().min(1),
    description: z.string().min(1).optional(),
    startedAt: z.string().min(1),
    endedAt: z.string().min(1),
    turnIds: z.array(z.string().min(1)),
    lastEventId: z.string().min(1).optional()
  })
  .strict();

export const TriggerAttemptRecordSchema = z
  .object({
    id: z.string().min(1),
    conversation: ConversationSchema,
    triggerName: z.string().min(1),
    reason: MessageWindowReasonSchema,
    eventId: z.string().min(1),
    eventIds: z.array(z.string().min(1)).min(1),
    probability: z.number().min(0).max(1),
    sample: z.number().min(0).lt(1),
    admitted: z.boolean(),
    evaluatedAt: z.string().min(1)
  })
  .strict();

export const ConversationSessionStateSchema = z
  .object({
    conversation: ConversationSchema,
    events: z.array(SessionEventRecordSchema),
    triggerAttempts: z.array(TriggerAttemptRecordSchema),
    windows: z.array(MessageWindowSchema),
    turns: z.array(SessionTurnRecordSchema),
    loopExits: z.array(AgentLoopExitRecordSchema)
  })
  .strict();

// A bounded diagnostic view of the in-memory store. This is not a persistence
// format; startup restoration reads message records from the journal instead.
export const SessionDiagnosticsSchema = z
  .object({
    exportedAt: z.string().min(1),
    conversations: z.array(ConversationSessionStateSchema)
  })
  .strict();

export const SessionJournalRecordSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("event"),
      recordedAt: z.string().min(1),
      record: SessionEventRecordSchema
    })
    .strict(),
  z
    .object({
      type: z.literal("trigger_attempt"),
      recordedAt: z.string().min(1),
      record: TriggerAttemptRecordSchema
    })
    .strict(),
  z
    .object({
      type: z.literal("message_window"),
      recordedAt: z.string().min(1),
      record: MessageWindowSchema
    })
    .strict(),
  z
    .object({
      type: z.literal("turn"),
      recordedAt: z.string().min(1),
      record: SessionTurnRecordSchema
    })
    .strict(),
  z
    .object({
      type: z.literal("loop_exit"),
      recordedAt: z.string().min(1),
      record: AgentLoopExitRecordSchema
    })
    .strict()
]);

export type MessageWindowReason = z.infer<typeof MessageWindowReasonSchema>;
export type TurnPhase = z.infer<typeof TurnPhaseSchema>;
export type SessionEventRecord = z.infer<typeof SessionEventRecordSchema>;
export type MessageWindow = z.infer<typeof MessageWindowSchema>;
export type TurnPhaseRecord = z.infer<typeof TurnPhaseRecordSchema>;
export type SessionTurnRecord = z.infer<typeof SessionTurnRecordSchema>;
export type AgentLoopExitRecord = z.infer<typeof AgentLoopExitRecordSchema>;
export type TriggerAttemptRecord = z.infer<typeof TriggerAttemptRecordSchema>;
export type ConversationSessionState = z.infer<
  typeof ConversationSessionStateSchema
>;
export type SessionDiagnostics = z.infer<typeof SessionDiagnosticsSchema>;
export type SessionJournalRecord = z.infer<typeof SessionJournalRecordSchema>;
