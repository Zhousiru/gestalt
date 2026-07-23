import { z } from "zod";

export const ToolNameSchema = z.enum([
  "say_nothing",
  "bash",
  "fetch_message",
  "read_image",
  "send_group_message",
  "send_dm",
  "send_image",
  "search_sticker",
  "send_sticker",
  "react_to_message",
  "poke_user",
  "recall_own_message",
  "leave"
]);

const ActionProposalBaseSchema = z
  .object({
    id: z.string().min(1),
    proposedAt: z.string().min(1),
    reason: z.string().min(1).optional()
  })
  .strict();

export const SayNothingActionProposalSchema = ActionProposalBaseSchema.extend({
  toolName: z.literal("say_nothing"),
  params: z.object({}).strict()
});

export const BashActionProposalSchema = ActionProposalBaseSchema.extend({
  toolName: z.literal("bash"),
  params: z
    .object({
      command: z.string().min(1)
    })
    .strict()
});

export const SendGroupMessageActionProposalSchema =
  ActionProposalBaseSchema.extend({
    toolName: z.literal("send_group_message"),
    params: z
      .object({
        groupId: z.string().min(1),
        text: z.string().min(1).max(2000)
      })
      .strict()
  });

export const SendDmActionProposalSchema = ActionProposalBaseSchema.extend({
  toolName: z.literal("send_dm"),
  params: z
    .object({
      userId: z.string().min(1),
      text: z.string().min(1).max(2000)
    })
    .strict()
});

const ConversationTargetSchema = z
  .object({
    kind: z.enum(["group", "private"]),
    id: z.string().min(1)
  })
  .strict();

export const SendImageActionProposalSchema = ActionProposalBaseSchema.extend({
  toolName: z.literal("send_image"),
  params: z
    .object({
      conversation: ConversationTargetSchema,
      file: z.string().min(1).max(4000),
      caption: z.string().min(1).max(1000).optional(),
      summary: z.string().min(1).max(200).optional(),
      replyToMessageId: z.string().min(1).optional()
    })
    .strict()
});

export const SearchStickerActionProposalSchema = ActionProposalBaseSchema.extend({
  toolName: z.literal("search_sticker"),
  params: z
    .object({
      query: z.string().min(1).max(1000),
      limit: z.number().int().min(1).max(20).optional()
    })
    .strict()
});

export const SendStickerActionProposalSchema = ActionProposalBaseSchema.extend({
  toolName: z.literal("send_sticker"),
  params: z
    .object({
      conversation: ConversationTargetSchema,
      stickerId: z.string().min(1).max(200),
      replyToMessageId: z.string().min(1).optional()
    })
    .strict()
});

export const FetchMessageActionProposalSchema =
  ActionProposalBaseSchema.extend({
    toolName: z.literal("fetch_message"),
    params: z
      .object({
        messageId: z.string().min(1)
      })
      .strict()
  });

export const ReadImageActionProposalSchema = ActionProposalBaseSchema.extend({
  toolName: z.literal("read_image"),
  params: z
    .object({
      file: z.string().min(1).max(4000)
    })
    .strict()
});

export const ReactToMessageActionProposalSchema =
  ActionProposalBaseSchema.extend({
    toolName: z.literal("react_to_message"),
    params: z
      .object({
        messageId: z.string().min(1),
        emojiId: z.string().min(1),
        remove: z.boolean().optional()
      })
      .strict()
  });

export const PokeUserActionProposalSchema = ActionProposalBaseSchema.extend({
  toolName: z.literal("poke_user"),
  params: z
    .object({
      userId: z.string().min(1),
      conversation: ConversationTargetSchema.optional()
    })
    .strict()
});

export const RecallOwnMessageActionProposalSchema =
  ActionProposalBaseSchema.extend({
    toolName: z.literal("recall_own_message"),
    params: z
      .object({
        messageId: z.string().min(1)
      })
      .strict()
  });

export const LeaveActionProposalSchema = ActionProposalBaseSchema.extend({
  toolName: z.literal("leave"),
  params: z.object({}).strict()
});

export const ActionProposalSchema = z.discriminatedUnion("toolName", [
  SayNothingActionProposalSchema,
  BashActionProposalSchema,
  FetchMessageActionProposalSchema,
  ReadImageActionProposalSchema,
  SendGroupMessageActionProposalSchema,
  SendDmActionProposalSchema,
  SendImageActionProposalSchema,
  SearchStickerActionProposalSchema,
  SendStickerActionProposalSchema,
  ReactToMessageActionProposalSchema,
  PokeUserActionProposalSchema,
  RecallOwnMessageActionProposalSchema,
  LeaveActionProposalSchema
]);

export const ToolDefinitionSchema = z
  .object({
    name: ToolNameSchema,
    purpose: z.string().min(1),
    whenUseful: z.array(z.string().min(1)),
    avoidWhen: z.array(z.string().min(1))
  })
  .strict();

export type ToolName = z.infer<typeof ToolNameSchema>;
export type ActionProposal = z.infer<typeof ActionProposalSchema>;
export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;
