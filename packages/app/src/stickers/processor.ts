import { createHash } from "node:crypto";
import type { StickerJobStatus, StickerJob, StickerRecord } from "./schemas";
import type { StickerStore } from "./store";
import type { StickerAnalyzer, StickerEmbedder } from "./models";
import type { StickerMediaResolver } from "./media";
import type { StickerVectorIndex } from "./lance";
import {
  stickerVectorIndexId,
  stickerVectorRowId,
  type StickerVectorChannel,
  type StickerVectorEntry
} from "./lance";
import { prepareStickerMedia } from "./contactSheet";
import { stickerIdFromSha256 } from "./id";

export interface StickerJobProcessorDependencies {
  store: StickerStore;
  mediaResolver: StickerMediaResolver;
  analyzer: StickerAnalyzer;
  embedder: StickerEmbedder;
  vectorIndex: StickerVectorIndex;
  now: () => Date;
  onStage: (
    job: StickerJob,
    status: StickerJobStatus,
    data?: Record<string, unknown>
  ) => Promise<StickerJob>;
  onMilestone: (
    job: StickerJob,
    type: string,
    data?: Record<string, unknown>
  ) => Promise<void>;
}

export async function processStickerJob(
  initialJob: StickerJob,
  dependencies: StickerJobProcessorDependencies
): Promise<StickerRecord> {
  let job = await dependencies.onStage(initialJob, "resolving_media");
  const bytes = await dependencies.mediaResolver.resolve(job);
  job = await dependencies.onStage(job, "downloading", {
    byteLength: bytes.byteLength
  });

  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const existing = await dependencies.store.findRecordBySha256(sha256);
  if (existing?.status === "ready" && existing.description) {
    const merged = mergeObservation(existing, job, dependencies.now().toISOString());
    const needsReindex =
      existing.embedding?.id !== stickerVectorIndexId(dependencies.embedder.id);
    job = await dependencies.store.updateJob(job.id, {
      status: needsReindex ? "embedding" : "indexing",
      stickerId: merged.id,
      duplicate: true,
      updatedAt: dependencies.now().toISOString()
    });
    await dependencies.onMilestone(job, "sticker.duplicate_found", {
      stickerId: merged.id
    });
    if (!needsReindex) {
      await dependencies.store.saveRecord(merged);
      await dependencies.onStage(job, "ready", {
        stickerId: merged.id,
        duplicate: true
      });
      return merged;
    }
    job = await dependencies.onStage(job, "embedding", {
      stickerId: merged.id,
      duplicate: true,
      model: dependencies.embedder.model
    });
    const indexed = await embedAndIndex(merged, dependencies, {
      async onEmbedded(embedding) {
        await dependencies.onMilestone(job, "sticker.embedding_completed", {
          provider: dependencies.embedder.provider,
          model: dependencies.embedder.model,
          dimensions: embedding.vector.length,
          id: stickerVectorIndexId(dependencies.embedder.id)
        });
        job = await dependencies.onStage(job, "indexing", {
          stickerId: merged.id
        });
      },
      async onIndexed() {
        await dependencies.onMilestone(job, "sticker.lancedb_upserted", {
          stickerId: merged.id
        });
      }
    });
    await dependencies.store.saveRecord(indexed);
    await dependencies.onStage(job, "ready", {
      stickerId: indexed.id,
      duplicate: true
    });
    return indexed;
  }

  const stickerId = stickerIdFromSha256(sha256);
  const conflictingRecord = await dependencies.store.readRecord(stickerId);
  if (conflictingRecord && conflictingRecord.asset.sha256 !== sha256) {
    throw new Error("Sticker id collision.");
  }

  job = await dependencies.onStage(job, "rendering", { sha256 });
  const prepared = await prepareStickerMedia(bytes);
  await dependencies.onMilestone(
    job,
    prepared.contactSheet
      ? "sticker.contact_sheet_created"
      : "sticker.media_prepared",
    {
      animated: prepared.animated,
      frameCount: prepared.frameCount,
      ...(prepared.contactSheet ? { sampledFrames: 16, layout: "4x4" } : {})
    }
  );
  const relativePath = await dependencies.store.saveBlob(
    sha256,
    prepared.extension,
    bytes
  );
  const contactSheetRelativePath = prepared.contactSheet
    ? await dependencies.store.saveBlob(
        createHash("sha256").update(prepared.contactSheet).digest("hex"),
        "png",
        prepared.contactSheet
      )
    : undefined;
  const at = dependencies.now().toISOString();
  const record = mergeObservation(
    {
      id: stickerId,
      status: "processing",
      asset: {
        sha256,
        mime: prepared.mime,
        relativePath,
        byteLength: bytes.byteLength,
        ...(prepared.width ? { width: prepared.width } : {}),
        ...(prepared.height ? { height: prepared.height } : {}),
        animated: prepared.animated,
        frameCount: prepared.frameCount,
        ...(contactSheetRelativePath ? { contactSheetRelativePath } : {})
      },
      createdAt: at,
      updatedAt: at
    },
    job,
    at
  );
  await dependencies.store.saveRecord(record);
  job = await dependencies.store.updateJob(job.id, {
    status: "describing",
    stickerId: record.id,
    updatedAt: dependencies.now().toISOString()
  });
  await dependencies.onStage(job, "describing", {
    stickerId: record.id,
    animated: prepared.animated,
    frameCount: prepared.frameCount,
    contactSheet: Boolean(prepared.contactSheet)
  });

  const description = await dependencies.analyzer.describe({
    image: prepared.analysisImage,
    mime: prepared.contactSheet ? "image/png" : prepared.mime,
    animated: prepared.animated,
    frameCount: prepared.frameCount,
    ...readPlatformSummary(job)
  });
  let described: StickerRecord = {
    ...record,
    description: description.description,
    analysis: {
      provider: description.provider,
      model: description.model,
      promptHash: description.promptHash,
      analyzedAt: dependencies.now().toISOString()
    },
    updatedAt: dependencies.now().toISOString()
  };
  await dependencies.store.saveRecord(described);
  await dependencies.onMilestone(job, "sticker.description_completed", {
    provider: description.provider,
    model: description.model,
    promptHash: description.promptHash,
    visual: description.description.visual,
    emotion: description.description.emotion,
    usageCount: description.description.usage.length
  });
  job = await dependencies.onStage(job, "embedding", {
    stickerId: described.id,
    model: dependencies.embedder.model
  });
  described = await embedAndIndex(described, dependencies, {
    async onEmbedded(embedding) {
      await dependencies.onMilestone(job, "sticker.embedding_completed", {
        provider: dependencies.embedder.provider,
        model: dependencies.embedder.model,
        dimensions: embedding.vector.length,
        id: stickerVectorIndexId(dependencies.embedder.id)
      });
      job = await dependencies.onStage(job, "indexing", {
        stickerId: described.id
      });
    },
    async onIndexed() {
      await dependencies.onMilestone(job, "sticker.lancedb_upserted", {
        stickerId: described.id
      });
    }
  });
  await dependencies.store.saveRecord(described);
  await dependencies.onStage(job, "ready", { stickerId: described.id });
  return described;
}

export async function embedAndIndex(
  record: StickerRecord,
  dependencies: Pick<
    StickerJobProcessorDependencies,
    "embedder" | "vectorIndex" | "now"
  >,
  callbacks: {
    onEmbedded?: (embedding: Awaited<ReturnType<StickerEmbedder["embed"]>>) => Promise<void>;
    onIndexed?: () => Promise<void>;
  } = {}
): Promise<StickerRecord> {
  if (!record.description) {
    throw new Error(`Sticker ${record.id} has no structured description to embed.`);
  }
  const units = stickerVectorDocuments(record);
  const embeddings = await Promise.all(
    units.map((unit) => dependencies.embedder.embed(unit.text))
  );
  const firstEmbedding = embeddings[0];
  if (!firstEmbedding) {
    throw new Error(`Sticker ${record.id} produced no embedding units.`);
  }
  if (
    dependencies.embedder.configuredDimensions !== undefined &&
    firstEmbedding.vector.length !== dependencies.embedder.configuredDimensions
  ) {
    throw new Error(
      `Embedding dimensions ${firstEmbedding.vector.length} do not match configured dimensions ${dependencies.embedder.configuredDimensions}.`
    );
  }
  if (embeddings.some((embedding) => embedding.vector.length !== firstEmbedding.vector.length)) {
    throw new Error("Embedding dimensions changed within one sticker projection.");
  }
  await callbacks.onEmbedded?.(firstEmbedding);
  const indexedAt = dependencies.now().toISOString();
  const entries: StickerVectorEntry[] = units.map((unit, index) => ({
    rowId: stickerVectorRowId(record.id, unit.channel, unit.unitIndex),
    stickerId: record.id,
    channel: unit.channel,
    unitIndex: unit.unitIndex,
    text: unit.text,
    vector: embeddings[index]!.vector,
    createdAt: indexedAt
  }));
  await dependencies.vectorIndex.upsert(entries);
  await callbacks.onIndexed?.();
  return {
    ...record,
    status: "ready",
    embedding: {
      id: stickerVectorIndexId(dependencies.embedder.id),
      dimensions: firstEmbedding.vector.length,
      units: {
        visual: 1,
        tags: 1,
        usage: record.description.usage.length
      },
      indexedAt
    },
    updatedAt: indexedAt
  };
}

export function stickerVectorDocuments(record: StickerRecord): Array<{
  channel: StickerVectorChannel;
  unitIndex: number;
  text: string;
}> {
  if (!record.description) {
    return [];
  }
  return [
    {
      channel: "visual",
      unitIndex: 0,
      text: record.description.visual
    },
    {
      channel: "tags",
      unitIndex: 0,
      text: record.description.emotion.join(", ")
    },
    ...record.description.usage.map((text, unitIndex) => ({
      channel: "usage" as const,
      unitIndex,
      text
    }))
  ];
}

function mergeObservation(
  record: StickerRecord,
  job: StickerJob,
  updatedAt: string
): StickerRecord {
  const mface = readMface(job) ?? record.mface;
  return {
    ...record,
    ...(mface ? { mface } : {}),
    updatedAt
  };
}

function readMface(job: StickerJob): StickerRecord["mface"] {
  if (job.sourceKind !== "mface") {
    return undefined;
  }
  const emojiId = readString(job.segment.data.emoji_id);
  const emojiPackageId = readString(job.segment.data.emoji_package_id);
  if (!emojiId || !emojiPackageId) {
    return undefined;
  }
  const key = readString(job.segment.data.key);
  const summary = readString(job.segment.data.summary);
  return {
    emojiId,
    emojiPackageId,
    ...(key ? { key } : {}),
    ...(summary ? { summary } : {})
  };
}

function readPlatformSummary(
  job: StickerJob
): { platformSummary?: string } {
  const summary = readString(job.segment.data.summary);
  return summary ? { platformSummary: summary } : {};
}

function readString(value: unknown): string | undefined {
  return value === undefined || value === null || String(value).length === 0
    ? undefined
    : String(value);
}
