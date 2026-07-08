import { z } from "zod";

export const EventSourceSchema = z
  .object({
    platform: z.string().min(1),
    connector: z.string().min(1).optional(),
    accountId: z.string().min(1).optional(),
    rawEventId: z.string().min(1).optional()
  })
  .strict();

export const ConversationSchema = z
  .object({
    kind: z.enum(["group", "private"]),
    id: z.string().min(1),
    name: z.string().min(1).optional()
  })
  .strict();

export const SenderSchema = z
  .object({
    id: z.string().min(1),
    displayName: z.string().min(1).optional(),
    isSelf: z.boolean().optional()
  })
  .strict();

export const MessageSchema = z
  .object({
    id: z.string().min(1),
    text: z.string(),
    rawText: z.string().optional(),
    mentionsBot: z.boolean().default(false),
    replyToMessageId: z.string().min(1).optional()
  })
  .strict();

export const MessageReceivedEventSchema = z
  .object({
    id: z.string().min(1),
    type: z.literal("MessageReceived"),
    occurredAt: z.string().min(1),
    source: EventSourceSchema,
    conversation: ConversationSchema,
    sender: SenderSchema,
    message: MessageSchema,
    raw: z.unknown().optional()
  })
  .strict();

export const CanonicalEventSchema = z.discriminatedUnion("type", [
  MessageReceivedEventSchema
]);

export type EventSource = z.infer<typeof EventSourceSchema>;
export type Conversation = z.infer<typeof ConversationSchema>;
export type Sender = z.infer<typeof SenderSchema>;
export type Message = z.infer<typeof MessageSchema>;
export type MessageReceivedEvent = z.infer<typeof MessageReceivedEventSchema>;
export type CanonicalEvent = z.infer<typeof CanonicalEventSchema>;
