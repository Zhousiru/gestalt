import { z } from "zod";
import { ActionProposalSchema } from "../tools/schemas";

export const SpanRecordSchema = z
  .object({
    id: z.string().min(1),
    traceId: z.string().min(1),
    parentSpanId: z.string().min(1).optional(),
    name: z.string().min(1),
    startedAt: z.string().min(1),
    endedAt: z.string().min(1),
    attributes: z.record(z.string(), z.unknown()).default({})
  })
  .strict();

export const ObservationRecordSchema = z
  .object({
    id: z.string().min(1),
    traceId: z.string().min(1),
    parentObservationId: z.string().min(1).optional(),
    type: z.enum(["event", "span", "generation", "tool", "agent", "chain"]),
    name: z.string().min(1),
    startedAt: z.string().min(1).optional(),
    endedAt: z.string().min(1).optional(),
    input: z.unknown().optional(),
    output: z.unknown().optional(),
    metadata: z.record(z.string(), z.unknown()).default({}),
    model: z.string().min(1).optional(),
    usage: z.unknown().optional(),
    level: z.enum(["DEBUG", "DEFAULT", "WARNING", "ERROR"]).optional(),
    statusMessage: z.string().min(1).optional()
  })
  .strict();

export const AgentTurnTraceSchema = z
  .object({
    id: z.string().min(1),
    name: z.literal("agent.turn"),
    startedAt: z.string().min(1),
    endedAt: z.string().min(1),
    gestaltHome: z.string().min(1),
    eventId: z.string().min(1),
    personaVersion: z.string().min(1),
    spans: z.array(SpanRecordSchema),
    observations: z.array(ObservationRecordSchema).default([]),
    proposedActions: z.array(ActionProposalSchema),
    toolResults: z.array(z.unknown())
  })
  .strict();

export type SpanRecord = z.infer<typeof SpanRecordSchema>;
export type ObservationRecord = z.infer<typeof ObservationRecordSchema>;
export type AgentTurnTrace = z.infer<typeof AgentTurnTraceSchema>;
