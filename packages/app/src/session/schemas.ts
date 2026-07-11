import { z } from "zod";
import { ConversationSchema, CanonicalEventSchema } from "../events/schemas";
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
    seq: z.number().int().positive(),
    receivedAt: z.string().min(1),
    event: CanonicalEventSchema
  })
  .strict();

export const MessageWindowSchema = z
  .object({
    id: z.string().min(1),
    conversation: ConversationSchema,
    reason: MessageWindowReasonSchema,
    fromSeq: z.number().int().positive(),
    toSeq: z.number().int().positive(),
    eventSeqs: z.array(z.number().int().positive()).min(1),
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
    traceId: z.string().min(1),
    conversation: ConversationSchema,
    status: z.enum(["completed", "cancelled", "failed"]),
    startedAt: z.string().min(1),
    endedAt: z.string().min(1),
    windowIds: z.array(z.string().min(1)).min(1),
    fromSeq: z.number().int().positive(),
    toSeq: z.number().int().positive(),
    eventSeqs: z.array(z.number().int().positive()).min(1),
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
    lastSeq: z.number().int().positive().optional()
  })
  .strict();

export const TriggerAttemptRecordSchema = z
  .object({
    id: z.string().min(1),
    conversation: ConversationSchema,
    triggerName: z.string().min(1),
    reason: MessageWindowReasonSchema,
    eventSeq: z.number().int().positive(),
    fromSeq: z.number().int().positive(),
    toSeq: z.number().int().positive(),
    probability: z.number().min(0).max(1),
    sample: z.number().min(0).lt(1),
    admitted: z.boolean(),
    samplerVersion: z.string().min(1),
    evaluatedAt: z.string().min(1)
  })
  .strict();

export const ConversationSessionSnapshotSchema = z
  .object({
    conversation: ConversationSchema,
    nextSeq: z.number().int().positive(),
    events: z.array(SessionEventRecordSchema),
    triggerAttempts: z.array(TriggerAttemptRecordSchema).default([]),
    windows: z.array(MessageWindowSchema),
    turns: z.array(SessionTurnRecordSchema),
    loopExits: z.array(AgentLoopExitRecordSchema).default([])
  })
  .strict();

export const SessionSnapshotSchema = z
  .object({
    version: z.literal(1),
    exportedAt: z.string().min(1),
    conversations: z.array(ConversationSessionSnapshotSchema)
  })
  .strict();

export type MessageWindowReason = z.infer<typeof MessageWindowReasonSchema>;
export type TurnPhase = z.infer<typeof TurnPhaseSchema>;
export type SessionEventRecord = z.infer<typeof SessionEventRecordSchema>;
export type MessageWindow = z.infer<typeof MessageWindowSchema>;
export type TurnPhaseRecord = z.infer<typeof TurnPhaseRecordSchema>;
export type SessionTurnRecord = z.infer<typeof SessionTurnRecordSchema>;
export type AgentLoopExitRecord = z.infer<typeof AgentLoopExitRecordSchema>;
export type TriggerAttemptRecord = z.infer<typeof TriggerAttemptRecordSchema>;
export type ConversationSessionSnapshot = z.infer<
  typeof ConversationSessionSnapshotSchema
>;
export type SessionSnapshot = z.infer<typeof SessionSnapshotSchema>;
