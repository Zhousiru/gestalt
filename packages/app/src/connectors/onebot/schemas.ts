import { z } from "zod";

export const OneBotMessageSegmentSchema = z
  .object({
    type: z.string().min(1),
    data: z.record(z.string(), z.unknown()).default({})
  })
  .passthrough();

export const OneBotMessageSchema = z.union([
  z.string(),
  OneBotMessageSegmentSchema,
  z.array(OneBotMessageSegmentSchema)
]);

const OneBotSenderBaseSchema = z
  .object({
    user_id: z.number(),
    nickname: z.string().optional()
  })
  .passthrough();

export const OneBotGroupSenderSchema = OneBotSenderBaseSchema.extend({
  card: z.string().optional(),
  role: z.string().optional()
}).passthrough();

export const OneBotPrivateSenderSchema = OneBotSenderBaseSchema.passthrough();

export const OneBotGroupMessageEventSchema = z
  .object({
    time: z.number(),
    self_id: z.number(),
    post_type: z.literal("message"),
    message_type: z.literal("group"),
    sub_type: z.string().optional(),
    message_id: z.number(),
    group_id: z.number(),
    user_id: z.number(),
    message: OneBotMessageSchema,
    raw_message: z.string().default(""),
    font: z.number().optional(),
    sender: OneBotGroupSenderSchema.optional(),
    anonymous: z.unknown().optional()
  })
  .passthrough();

export const OneBotPrivateMessageEventSchema = z
  .object({
    time: z.number(),
    self_id: z.number(),
    post_type: z.literal("message"),
    message_type: z.literal("private"),
    sub_type: z.string().optional(),
    message_id: z.number(),
    user_id: z.number(),
    message: OneBotMessageSchema,
    raw_message: z.string().default(""),
    font: z.number().optional(),
    sender: OneBotPrivateSenderSchema.optional()
  })
  .passthrough();

export const OneBotMessageEventSchema = z.discriminatedUnion("message_type", [
  OneBotGroupMessageEventSchema,
  OneBotPrivateMessageEventSchema
]);

export const OneBotEventSchema = OneBotMessageEventSchema;

export const OneBotActionResponseSchema = z
  .object({
    status: z.string(),
    retcode: z.number(),
    data: z.unknown().nullable().optional(),
    echo: z.unknown().optional(),
    message: z.string().optional(),
    wording: z.string().optional()
  })
  .passthrough();

export type OneBotMessageSegment = z.infer<typeof OneBotMessageSegmentSchema>;
export type OneBotMessage = z.infer<typeof OneBotMessageSchema>;
export type OneBotMessageEvent = z.infer<typeof OneBotMessageEventSchema>;
export type OneBotEvent = z.infer<typeof OneBotEventSchema>;
export type OneBotActionResponse = z.infer<typeof OneBotActionResponseSchema>;
