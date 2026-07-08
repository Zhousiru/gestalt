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
    proposedActions: z.array(ActionProposalSchema),
    toolResults: z.array(z.unknown())
  })
  .strict();

export type SpanRecord = z.infer<typeof SpanRecordSchema>;
export type AgentTurnTrace = z.infer<typeof AgentTurnTraceSchema>;
