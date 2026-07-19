import { z } from "zod";
import { ConversationSchema, SourceMessageSegmentSchema } from "../events/schemas";

export const StickerSourceKindSchema = z.enum(["mface", "image"]);

export const StickerJobStatusSchema = z.enum([
  "queued",
  "resolving_media",
  "downloading",
  "rendering",
  "describing",
  "embedding",
  "indexing",
  "ready",
  "failed"
]);

export const StickerObservationSchema = z
  .object({
    sourceKind: StickerSourceKindSchema,
    eventId: z.string().min(1),
    messageId: z.string().min(1),
    conversation: ConversationSchema,
    senderId: z.string().min(1),
    occurredAt: z.string().min(1),
    segmentIndex: z.number().int().nonnegative().default(0),
    segment: SourceMessageSegmentSchema
  })
  .strict();

export const StickerJobSchema = z
  .object({
    id: z.string().min(1),
    status: StickerJobStatusSchema,
    sourceKind: StickerSourceKindSchema,
    eventId: z.string().min(1),
    messageId: z.string().min(1),
    conversation: ConversationSchema,
    senderId: z.string().min(1),
    occurredAt: z.string().min(1),
    segmentIndex: z.number().int().nonnegative().default(0),
    segment: SourceMessageSegmentSchema,
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
    attempts: z.number().int().nonnegative(),
    stickerId: z.string().min(1).optional(),
    duplicate: z.boolean().optional(),
    failedStage: StickerJobStatusSchema.optional(),
    error: z.string().min(1).optional()
  })
  .strict();

export const StickerAssetSchema = z
  .object({
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    mime: z.string().min(1),
    relativePath: z.string().min(1),
    byteLength: z.number().int().nonnegative(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    animated: z.boolean(),
    frameCount: z.number().int().positive(),
    contactSheetRelativePath: z.string().min(1).optional()
  })
  .strict();

export const StickerMfaceDeliverySchema = z
  .object({
    emojiId: z.string().min(1),
    emojiPackageId: z.string().min(1),
    key: z.string().min(1).optional(),
    summary: z.string().min(1).optional()
  })
  .strict();

export const StickerDescriptionSchema = z
  .object({
    visual: z.string().trim().min(1).max(1200),
    emotion: z.array(z.string().trim().min(1).max(48)).min(1).max(8),
    usage: z.array(z.string().trim().min(1).max(120)).min(10).max(20)
  })
  .strict();

export const StickerRecordSchema = z
  .object({
    id: z.string().min(1),
    status: z.enum(["processing", "ready", "failed"]),
    description: StickerDescriptionSchema.optional(),
    asset: StickerAssetSchema,
    mface: StickerMfaceDeliverySchema.optional(),
    embedding: z
      .object({
        id: z.string().min(1),
        dimensions: z.number().int().positive(),
        units: z
          .object({
            visual: z.literal(1),
            tags: z.literal(1),
            usage: z.number().int().min(10).max(20)
          })
          .strict(),
        indexedAt: z.string().min(1)
      })
      .strict()
      .optional(),
    analysis: z
      .object({
        provider: z.string().min(1),
        model: z.string().min(1),
        promptHash: z.string().min(1),
        analyzedAt: z.string().min(1)
      })
      .strict()
      .optional(),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
    lastError: z.string().min(1).optional()
  })
  .strict();

export const StickerLogEntrySchema = z
  .object({
    type: z.string().regex(/^sticker\./),
    at: z.string().min(1),
    jobId: z.string().min(1).optional(),
    stickerId: z.string().min(1).optional(),
    sourceEventId: z.string().min(1).optional(),
    conversationId: z.string().min(1).optional(),
    agentTraceId: z.string().min(1).optional(),
    data: z.record(z.string(), z.unknown()).default({})
  })
  .strict();

export type StickerSourceKind = z.infer<typeof StickerSourceKindSchema>;
export type StickerObservation = z.infer<typeof StickerObservationSchema>;
export type StickerJob = z.infer<typeof StickerJobSchema>;
export type StickerJobStatus = z.infer<typeof StickerJobStatusSchema>;
export type StickerAsset = z.infer<typeof StickerAssetSchema>;
export type StickerDescription = z.infer<typeof StickerDescriptionSchema>;
export type StickerRecord = z.infer<typeof StickerRecordSchema>;
export type StickerLogEntry = z.infer<typeof StickerLogEntrySchema>;
