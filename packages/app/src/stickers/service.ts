import { readFile } from "node:fs/promises";
import type { Connector, ConnectorCallResult } from "../connectors/types";
import { renderCqCode } from "../connectors/onebot/message";
import type { MessageReceivedEvent } from "../events/schemas";
import type { GestaltHome } from "../home/resolveGestaltHome";
import type { LiveEventSink } from "../live/viewTypes";
import { redactSensitiveString } from "../privacy/stickerRedaction";
import {
  extractIgnoredStickerSegments,
  extractStickerObservations
} from "./extract";
import type { StickerVectorIndex, StickerSearchResult } from "./lance";
import type { StickerLogger } from "./logger";
import type { StickerMediaResolver } from "./media";
import type { StickerAnalyzer, StickerEmbedder } from "./models";
import { prepareStickerMedia } from "./contactSheet";
import { embedAndIndex, processStickerJob } from "./processor";
import type { StickerJob, StickerJobStatus, StickerRecord } from "./schemas";
import type { StickerStore } from "./store";

const MAX_PROCESSING_ATTEMPTS = 3;
const MAX_INDEX_AUDIT_ATTEMPTS = 3;
const WORKER_RETRY_BASE_MS = 25;
const WORKER_RETRY_MAX_MS = 1_000;
const STICKER_NOT_READY_ERROR = "Sticker is not ready.";
const STICKER_DELIVERY_ERROR = "Sticker delivery failed.";

export const DEFAULT_STICKER_CATALOG_LIMIT = 48;
export const MAX_STICKER_CATALOG_LIMIT = 100;
export const MAX_STICKER_MANAGEMENT_BATCH = 100;

export type StickerCatalogStatusFilter =
  | "all"
  | "ready"
  | "processing"
  | "failed";
export type StickerCatalogSourceFilter =
  | "all"
  | "mface"
  | "image-sticker";

export interface StickerCatalogQuery {
  offset?: number;
  limit?: number;
  query?: string;
  status?: StickerCatalogStatusFilter;
  source?: StickerCatalogSourceFilter;
}

export interface NormalizedStickerCatalogQuery {
  offset: number;
  limit: number;
  query: string;
  status: StickerCatalogStatusFilter;
  source: StickerCatalogSourceFilter;
}

export interface StickerRuntimeSnapshot {
  available: true;
  generatedAt: string;
  scraping: {
    configuredEnabled: boolean;
    runtimeOverride?: boolean;
    effectiveEnabled: boolean;
  };
  processing: {
    queued: number;
    running: number;
    failed: number;
    ready: number;
    duplicates: number;
  };
  embedding: {
    provider?: string;
    model?: string;
    dimensions?: number;
    id?: string;
    rowCount: number;
    indexState: "empty" | "ready" | "rebuilding" | "error";
    error?: string;
  };
  jobs: StickerJobView[];
  catalog: {
    offset: number;
    limit: number;
    total: number;
  };
  stickers: StickerView[];
}

export interface StickerJobView {
  id: string;
  stickerId?: string;
  sourceKind: StickerJob["sourceKind"];
  status: StickerJob["status"];
  conversationId: string;
  createdAt: string;
  updatedAt: string;
  stage: StickerJob["status"];
  lastFailedStage?: StickerJob["status"];
  animated?: boolean;
  error?: string;
  thumbnailUrl?: string;
  contactSheetUrl?: string;
  desc?: string;
}

export interface StickerView {
  id: string;
  desc: string;
  status: StickerRecord["status"];
  sourceKind: StickerJob["sourceKind"];
  animated: boolean;
  createdAt: string;
  updatedAt: string;
  thumbnailUrl: string;
  contactSheetUrl?: string;
  embeddingStatus: "ready" | "stale" | "missing";
  lastError?: string;
}

export type StickerManagementAction = "delete" | "rebuild";
export type StickerManagementOutcome =
  | "deleted"
  | "rebuilt"
  | "not_found"
  | "busy"
  | "failed";

export interface StickerManagementResult {
  stickerId: string;
  ok: boolean;
  outcome: StickerManagementOutcome;
  error?: string;
}

export interface StickerManagementResponse {
  action: StickerManagementAction;
  requested: number;
  succeeded: number;
  failed: number;
  results: StickerManagementResult[];
}

export interface StickerService {
  readonly configuredEnabled: boolean;
  isScrapingEnabled(): boolean;
  setScrapingOverride(
    enabled: boolean,
    context: { actorUserId: string; sourceEventId: string; at: string }
  ): Promise<boolean>;
  toggleScraping(
    context: { actorUserId: string; sourceEventId: string; at: string }
  ): Promise<boolean>;
  observe(event: MessageReceivedEvent): Promise<number>;
  search(input: {
    query: string;
    limit?: number;
    agentTraceId?: string;
  }): Promise<StickerSearchResult[]>;
  send(input: {
    conversation: MessageReceivedEvent["conversation"];
    stickerId: string;
    replyToMessageId?: string;
    agentTraceId?: string;
  }): Promise<ConnectorCallResult>;
  manage(input: {
    action: StickerManagementAction;
    stickerIds: readonly string[];
  }): Promise<StickerManagementResponse>;
  snapshot(query?: StickerCatalogQuery): Promise<StickerRuntimeSnapshot>;
  resolveAssetPath(
    stickerId: string,
    variant: "original" | "contact-sheet"
  ): Promise<string | undefined>;
  whenIdle(): Promise<void>;
}

export interface CreateStickerServiceInput {
  home: GestaltHome;
  connector: Connector;
  store: StickerStore;
  logger: StickerLogger;
  mediaResolver: StickerMediaResolver;
  analyzer: StickerAnalyzer;
  embedder: StickerEmbedder;
  vectorIndex: StickerVectorIndex;
  configuredEnabled: boolean;
  processingConcurrency?: number;
  liveEvents?: LiveEventSink;
  now?: () => Date;
}

export function createStickerService(
  input: CreateStickerServiceInput
): StickerService {
  const now = input.now ?? (() => new Date());
  const processingConcurrency = input.processingConcurrency ?? 1;
  if (!Number.isInteger(processingConcurrency) || processingConcurrency < 1) {
    throw new Error("Sticker processing concurrency must be a positive integer.");
  }
  let runtimeOverride: boolean | undefined;
  let workerPromise: Promise<void> | undefined;
  let workerRerunRequested = false;
  let needsIndexAudit = true;
  let rebuildingIndex = false;
  let indexAuditError: string | undefined;
  let managementQueue: Promise<void> = Promise.resolve();

  const publish = (
    type: Parameters<LiveEventSink["publish"]>[0],
    data: unknown,
    at: string
  ): void => {
    try {
      input.liveEvents?.publish(type, data, at);
    } catch {
      // Live UI updates are diagnostics. They must never affect sticker state
      // transitions or connector delivery semantics.
    }
  };

  const log = async (
    type: string,
    context: {
      at?: string;
      jobId?: string;
      stickerId?: string;
      sourceEventId?: string;
      conversationId?: string;
      agentTraceId?: string;
      data?: Record<string, unknown>;
    } = {}
  ): Promise<void> => {
    const at = context.at ?? now().toISOString();
    try {
      await input.logger.append({
        type,
        at,
        ...(context.jobId ? { jobId: context.jobId } : {}),
        ...(context.stickerId ? { stickerId: context.stickerId } : {}),
        ...(context.sourceEventId ? { sourceEventId: context.sourceEventId } : {}),
        ...(context.conversationId
          ? { conversationId: context.conversationId }
          : {}),
        ...(context.agentTraceId ? { agentTraceId: context.agentTraceId } : {}),
        data: context.data ?? {}
      });
    } catch {
      // sticker-logs are durable diagnostics, not part of the state or send
      // transaction. A broken log sink must not retry processing or delivery.
    }
  };

  const updateStage = async (
    job: StickerJob,
    status: StickerJobStatus,
    data: Record<string, unknown> = {}
  ): Promise<StickerJob> => {
    const at = now().toISOString();
    const updated = await input.store.updateJob(job.id, {
      status,
      updatedAt: at,
      ...(job.stickerId ? { stickerId: job.stickerId } : {})
    });
    await log(stageLogType(status), {
      at,
      jobId: updated.id,
      ...(updated.stickerId ? { stickerId: updated.stickerId } : {}),
      sourceEventId: updated.eventId,
      conversationId: updated.conversation.id,
      data: { status, ...data }
    });
    publish("sticker.job.updated", { job: updated, data }, at);
    return updated;
  };

  const processJob = async (job: StickerJob): Promise<void> => {
    try {
      const updated = await input.store.updateJob(job.id, {
        attempts: job.attempts + 1,
        updatedAt: now().toISOString(),
        failedStage: undefined,
        error: undefined
      });
      const record = await processStickerJob(updated, {
        store: input.store,
        mediaResolver: input.mediaResolver,
        analyzer: input.analyzer,
        embedder: input.embedder,
        vectorIndex: input.vectorIndex,
        now,
        onStage: updateStage,
        async onMilestone(milestoneJob, type, data = {}) {
          const at = now().toISOString();
          await log(type, {
            at,
            jobId: milestoneJob.id,
            ...(milestoneJob.stickerId
              ? { stickerId: milestoneJob.stickerId }
              : {}),
            sourceEventId: milestoneJob.eventId,
            conversationId: milestoneJob.conversation.id,
            data
          });
        }
      });
      publish(
        "sticker.catalog.updated",
        { stickerId: record.id },
        record.updatedAt
      );
    } catch (error) {
      const message = errorMessage(error);
      const at = now().toISOString();
      const current = await input.store.readJob(job.id);
      if (current && current.attempts < MAX_PROCESSING_ATTEMPTS) {
        const queued = await input.store.updateJob(job.id, {
          status: "queued",
          updatedAt: at,
          failedStage: current.status,
          error: message,
          ...(current.stickerId ? { stickerId: current.stickerId } : {}),
          ...(current.duplicate !== undefined
            ? { duplicate: current.duplicate }
            : {})
        });
        await log("sticker.retry_scheduled", {
          at,
          jobId: queued.id,
          ...(queued.stickerId ? { stickerId: queued.stickerId } : {}),
          sourceEventId: queued.eventId,
          conversationId: queued.conversation.id,
          data: {
            error: message,
            attempt: queued.attempts,
            maxAttempts: MAX_PROCESSING_ATTEMPTS
          }
        });
        publish("sticker.job.updated", { job: queued }, at);
        return;
      }
      const failed = await input.store.updateJob(job.id, {
        status: "failed",
        updatedAt: at,
        ...(current ? { failedStage: current.status } : {}),
        error: message,
        ...(current?.stickerId ? { stickerId: current.stickerId } : {})
      });
      if (failed.stickerId && !failed.duplicate) {
        const record = await input.store.readRecord(failed.stickerId);
        if (record && record.status !== "ready") {
          await input.store.saveRecord({
            ...record,
            status: "failed",
            lastError: message,
            updatedAt: at
          });
        }
      }
      await log("sticker.failed", {
        at,
        jobId: failed.id,
        ...(failed.stickerId ? { stickerId: failed.stickerId } : {}),
        sourceEventId: failed.eventId,
        conversationId: failed.conversation.id,
        data: { error: message, attempts: failed.attempts }
      });
      publish("sticker.job.updated", { job: failed }, at);
    }
  };

  const auditIndex = async (): Promise<void> => {
    if (!needsIndexAudit) {
      return;
    }
    needsIndexAudit = false;
    const records = (await input.store.listRecords()).filter(
      (record) => record.status === "ready" && Boolean(record.desc)
    );
    const expectedStickerIds = new Set(records.map((record) => record.id));
    const expectedRows = expectedStickerIds.size;
    const indexSnapshot = await input.vectorIndex.snapshot();
    const indexedStickerIds = new Set(await input.vectorIndex.listStickerIds());
    const missingStickerIds = [...expectedStickerIds].filter(
      (id) => !indexedStickerIds.has(id)
    );
    const orphanStickerIds = [...indexedStickerIds].filter(
      (id) => !expectedStickerIds.has(id)
    );
    const stale = records.filter(
      (record) => record.embedding?.id !== input.embedder.id
    );
    if (
      stale.length === 0 &&
      missingStickerIds.length === 0 &&
      orphanStickerIds.length === 0
    ) {
      indexAuditError = undefined;
      return;
    }
    rebuildingIndex = true;
    publish(
      "sticker.index.updated",
      {
        state: "rebuilding",
        expectedRows,
        currentRows: indexSnapshot.rowCount,
        missingRows: missingStickerIds.length,
        orphanRows: orphanStickerIds.length
      },
      now().toISOString()
    );
    if (orphanStickerIds.length > 0) {
      const deletedRows = await input.vectorIndex.deleteStickerIds(
        orphanStickerIds
      );
      await log("sticker.lancedb_pruned", {
        data: {
          requestedRows: orphanStickerIds.length,
          deletedRows,
          id: input.embedder.id
        }
      });
    }
    const missingIdSet = new Set(missingStickerIds);
    const staleIds = new Set(stale.map((record) => record.id));
    let pending = records.filter(
      (record) =>
        staleIds.has(record.id) || missingIdSet.has(record.id)
    );
    for (
      let attempt = 1;
      attempt <= MAX_INDEX_AUDIT_ATTEMPTS && pending.length > 0;
      attempt += 1
    ) {
      const failed: typeof pending = [];
      for (const record of pending) {
        try {
          const indexed = await embedAndIndex(record, {
            embedder: input.embedder,
            vectorIndex: input.vectorIndex,
            now
          });
          await input.store.saveRecord(indexed);
          await log("sticker.lancedb_upserted", {
            stickerId: indexed.id,
            data: {
              reindex: true,
              attempt,
              dimensions: indexed.embedding?.dimensions,
              id: indexed.embedding?.id
            }
          });
        } catch (error) {
          failed.push(record);
          await log("sticker.failed", {
            stickerId: record.id,
            data: {
              stage: "reindex",
              attempt,
              maxAttempts: MAX_INDEX_AUDIT_ATTEMPTS,
              error: errorMessage(error)
            }
          });
        }
      }
      pending = failed;
    }
    rebuildingIndex = false;
    if (pending.length > 0) {
      needsIndexAudit = true;
      indexAuditError = `Failed to rebuild ${pending.length} sticker record(s).`;
      publish(
        "sticker.index.updated",
        {
          state: "error",
          error: indexAuditError,
          stickerIds: pending.map((record) => record.id)
        },
        now().toISOString()
      );
      return;
    }
    indexAuditError = undefined;
    publish("sticker.index.updated", { state: "ready" }, now().toISOString());
  };

  const drain = async (): Promise<void> => {
    const active = new Map<string, Promise<void>>();
    let taskError: unknown;
    while (true) {
      const jobs = await input.store.listJobs();
      const availableSlots = processingConcurrency - active.size;
      const next = jobs
        .filter(
          (job) =>
            job.status !== "ready" &&
            job.status !== "failed" &&
            !active.has(job.id)
        )
        .slice(0, availableSlots);
      for (const job of next) {
        const task = processJob(job)
          .catch((error: unknown) => {
            taskError ??= error;
          })
          .finally(() => {
            active.delete(job.id);
          });
        active.set(job.id, task);
      }
      if (active.size === 0) {
        break;
      }
      await Promise.race([...active.values(), wait(100)]);
    }
    if (taskError !== undefined) {
      throw taskError;
    }
    await auditIndex();
  };

  const hasNonterminalJobs = async (): Promise<boolean> => {
    try {
      return (await input.store.listJobs()).some(
        (job) => job.status !== "ready" && job.status !== "failed"
      );
    } catch {
      // The same transient store failure may affect this probe. Conservatively
      // retry with backoff instead of abandoning potentially persisted work.
      return true;
    }
  };

  const runWorker = async (): Promise<void> => {
    let consecutiveFailures = 0;
    do {
      workerRerunRequested = false;
      try {
        await drain();
        consecutiveFailures = 0;
      } catch (error) {
        needsIndexAudit = true;
        rebuildingIndex = false;
        indexAuditError = errorMessage(error);
        consecutiveFailures += 1;
        const at = now().toISOString();
        const retry = workerRerunRequested || (await hasNonterminalJobs());
        const retryInMs = workerRetryDelay(consecutiveFailures);
        await log("sticker.worker_failed", {
          at,
          data: {
            error: errorMessage(error),
            consecutiveFailures,
            retry,
            ...(retry ? { retryInMs } : {})
          }
        });
        publish(
          "sticker.index.updated",
          {
            state: "error",
            error: errorMessage(error),
            retry,
            ...(retry ? { retryInMs } : {})
          },
          at
        );
        if (retry) {
          await wait(retryInMs);
          workerRerunRequested = true;
        }
      }
    } while (workerRerunRequested);
  };

  const kickWorker = (): void => {
    if (workerPromise) {
      workerRerunRequested = true;
      return;
    }
    workerRerunRequested = false;
    workerPromise = runWorker()
      .catch(() => {
        // runWorker contains operational failures. This final guard ensures a
        // diagnostics or timer defect cannot become an unhandled rejection.
      })
      .finally(() => {
        workerPromise = undefined;
        if (workerRerunRequested) {
          kickWorker();
        }
      });
  };

  const enqueueManagement = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = managementQueue.then(operation);
    managementQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  };

  const deleteStickers = async (
    stickerIds: readonly string[]
  ): Promise<StickerManagementResponse> => {
    const results: StickerManagementResult[] = [];
    const deletedRecords: StickerRecord[] = [];

    for (const stickerId of stickerIds) {
      try {
        const record = await input.store.readRecord(stickerId);
        if (!record) {
          results.push({
            stickerId,
            ok: false,
            outcome: "not_found",
            error: "Sticker record was not found."
          });
          continue;
        }
        if (record.status === "processing") {
          results.push({
            stickerId,
            ok: false,
            outcome: "busy",
            error: "Sticker is still processing."
          });
          continue;
        }
        const deleted = await input.store.deleteRecord(stickerId);
        if (!deleted) {
          results.push({
            stickerId,
            ok: false,
            outcome: "not_found",
            error: "Sticker record was not found."
          });
          continue;
        }
        deletedRecords.push(deleted);
        results.push({ stickerId, ok: true, outcome: "deleted" });
      } catch (error) {
        results.push({
          stickerId,
          ok: false,
          outcome: "failed",
          error: errorMessage(error)
        });
      }
    }

    if (deletedRecords.length > 0) {
      const deletedIds = deletedRecords.map((record) => record.id);
      const at = now().toISOString();
      try {
        const deletedRows = await input.vectorIndex.deleteStickerIds(deletedIds);
        await log("sticker.management_delete_completed", {
          at,
          data: {
            stickerIds: deletedIds,
            deletedRecords: deletedIds.length,
            deletedRows
          }
        });
        publish(
          "sticker.index.updated",
          {
            state: indexAuditError ? "error" : "ready",
            ...(indexAuditError ? { error: indexAuditError } : {}),
            deletedRows,
            stickerIds: deletedIds
          },
          at
        );
      } catch (error) {
        needsIndexAudit = true;
        indexAuditError = errorMessage(error);
        await log("sticker.management_delete_cleanup_failed", {
          at,
          data: { stickerIds: deletedIds, error: indexAuditError }
        });
        publish(
          "sticker.index.updated",
          { state: "error", error: indexAuditError, stickerIds: deletedIds },
          at
        );
        kickWorker();
      }

      const remainingRecords = await input.store.listRecords();
      const referencedPaths = new Set(
        remainingRecords.flatMap((record) => stickerAssetPaths(record))
      );
      const deletedPaths = new Set(
        deletedRecords.flatMap((record) => stickerAssetPaths(record))
      );
      for (const relativePath of deletedPaths) {
        if (referencedPaths.has(relativePath)) {
          continue;
        }
        try {
          await input.store.deleteBlob(relativePath);
        } catch (error) {
          await log("sticker.management_delete_cleanup_failed", {
            at,
            data: {
              stickerIds: deletedIds,
              cleanup: "blob",
              error: errorMessage(error)
            }
          });
        }
      }
      publish(
        "sticker.catalog.updated",
        { action: "delete", stickerIds: deletedIds },
        at
      );
    }

    return managementResponse("delete", results);
  };

  const rebuildStickers = async (
    stickerIds: readonly string[]
  ): Promise<StickerManagementResponse> => {
    const jobs = await input.store.listJobs();
    const results = await mapWithConcurrency(
      stickerIds,
      processingConcurrency,
      async (stickerId): Promise<StickerManagementResult> => {
        const startedAt = now().toISOString();
        try {
          const record = await input.store.readRecord(stickerId);
          if (!record) {
            return {
              stickerId,
              ok: false,
              outcome: "not_found",
              error: "Sticker record was not found."
            };
          }
          if (record.status === "processing") {
            return {
              stickerId,
              ok: false,
              outcome: "busy",
              error: "Sticker is still processing."
            };
          }
          await log("sticker.management_rebuild_started", {
            at: startedAt,
            stickerId
          });
          const bytes = await readFile(
            input.store.absolutePath(record.asset.relativePath)
          );
          const prepared = await prepareStickerMedia(bytes);
          const sourceJob = latestJobForSticker(jobs, stickerId);
          const platformSummary =
            record.mface?.summary ??
            (sourceJob ? stickerJobPlatformSummary(sourceJob) : undefined);
          const description = await input.analyzer.describe({
            image: prepared.analysisImage,
            mime: prepared.contactSheet ? "image/png" : prepared.mime,
            animated: prepared.animated,
            frameCount: prepared.frameCount,
            ...(platformSummary ? { platformSummary } : {})
          });
          const desc = description.desc.trim();
          if (!desc) {
            throw new Error("Sticker analyzer returned an empty description.");
          }
          const { lastError: _lastError, ...recordWithoutError } = record;
          const indexed = await embedAndIndex(
            {
              ...recordWithoutError,
              status: "processing",
              desc,
              analysis: {
                provider: description.provider,
                model: description.model,
                promptHash: description.promptHash,
                analyzedAt: now().toISOString()
              },
              updatedAt: now().toISOString()
            },
            {
              embedder: input.embedder,
              vectorIndex: input.vectorIndex,
              now
            }
          );
          await input.store.saveRecord(indexed);
          const completedAt = now().toISOString();
          await log("sticker.management_rebuild_completed", {
            at: completedAt,
            stickerId,
            data: {
              provider: description.provider,
              model: description.model,
              promptHash: description.promptHash,
              embeddingId: input.embedder.id,
              dimensions: indexed.embedding?.dimensions
            }
          });
          publish(
            "sticker.catalog.updated",
            { action: "rebuild", stickerId },
            completedAt
          );
          return { stickerId, ok: true, outcome: "rebuilt" };
        } catch (error) {
          const message = errorMessage(error);
          await log("sticker.management_rebuild_failed", {
            at: now().toISOString(),
            stickerId,
            data: { error: message }
          });
          return {
            stickerId,
            ok: false,
            outcome: "failed",
            error: message
          };
        }
      }
    );
    return managementResponse("rebuild", results);
  };

  const service: StickerService = {
    configuredEnabled: input.configuredEnabled,

    isScrapingEnabled() {
      return runtimeOverride ?? input.configuredEnabled;
    },

    async setScrapingOverride(enabled, context) {
      const before = this.isScrapingEnabled();
      runtimeOverride = enabled;
      const after = this.isScrapingEnabled();
      await log("sticker.scraping_state_changed", {
        at: context.at,
        sourceEventId: context.sourceEventId,
        data: {
          from: before,
          to: after,
          configuredEnabled: input.configuredEnabled,
          runtimeOverride,
          actorUserId: context.actorUserId,
          source: "slash_command"
        }
      });
      publish(
        "sticker.scraping.state_changed",
        {
          configuredEnabled: input.configuredEnabled,
          runtimeOverride,
          effectiveEnabled: after
        },
        context.at
      );
      return after;
    },

    toggleScraping(context) {
      return this.setScrapingOverride(!this.isScrapingEnabled(), context);
    },

    async observe(event) {
      const observations = extractStickerObservations(event);
      const ignoredSegments = extractIgnoredStickerSegments(event);
      if (ignoredSegments.length > 0) {
        await log("sticker.ignored", {
          sourceEventId: event.id,
          conversationId: event.conversation.id,
          data: {
            reason: "not_collectable",
            segments: ignoredSegments
          }
        });
      }
      if (observations.length === 0) {
        return 0;
      }
      if (!this.isScrapingEnabled()) {
        await Promise.all(
          observations.map((observation) =>
            log("sticker.ignored", {
              sourceEventId: observation.eventId,
              conversationId: observation.conversation.id,
              data: {
                reason: "scraping_disabled",
                sourceKind: observation.sourceKind
              }
            })
          )
        );
        return 0;
      }
      const jobs = await Promise.all(
        observations.map(async (observation) => {
          const at = now().toISOString();
          try {
            const job = await input.store.createJob(observation, at);
            // Persisted work must be made visible to the worker before any
            // best-effort observability call can fail.
            kickWorker();
            await log("sticker.job_queued", {
              at,
              jobId: job.id,
              sourceEventId: job.eventId,
              conversationId: job.conversation.id,
              data: { sourceKind: job.sourceKind }
            });
            publish("sticker.job.updated", { job }, at);
            return job;
          } catch (error) {
            await log("sticker.observation_failed", {
              at,
              sourceEventId: observation.eventId,
              conversationId: observation.conversation.id,
              data: {
                reason: "job_persistence_failed",
                sourceKind: observation.sourceKind,
                segmentIndex: observation.segmentIndex,
                error: errorMessage(error)
              }
            });
            return undefined;
          }
        })
      );
      return jobs.filter((job): job is StickerJob => Boolean(job)).length;
    },

    async search(searchInput) {
      const limit = Math.min(20, Math.max(1, searchInput.limit ?? 8));
      const startedAt = now().toISOString();
      try {
        const embedding = await input.embedder.embed(searchInput.query);
        const results: StickerSearchResult[] = [];
        const seen = new Set<string>();
        const pageSize = Math.min(100, Math.max(32, limit * 4));
        let offset = 0;
        while (results.length < limit) {
          const candidates = await input.vectorIndex.search({
            vector: embedding.vector,
            limit: pageSize,
            offset
          });
          for (const candidate of candidates) {
            if (seen.has(candidate.stickerId)) {
              continue;
            }
            seen.add(candidate.stickerId);
            const record = await input.store.readRecord(candidate.stickerId);
            if (
              !record ||
              record.status !== "ready" ||
              !record.desc ||
              record.embedding?.id !== input.embedder.id
            ) {
              continue;
            }
            results.push({
              stickerId: record.id,
              desc: record.desc,
              ...(candidate.distance !== undefined
                ? { distance: candidate.distance }
                : {})
            });
            if (results.length >= limit) {
              break;
            }
          }
          offset += candidates.length;
          if (results.length >= limit || candidates.length < pageSize) {
            break;
          }
        }
        const at = now().toISOString();
        await log("sticker.search_completed", {
          at,
          ...(searchInput.agentTraceId
            ? { agentTraceId: searchInput.agentTraceId }
            : {}),
          data: {
            query: searchInput.query,
            limit,
            resultCount: results.length,
            candidates: results.map((result) => ({
              stickerId: result.stickerId,
              distance: result.distance
            })),
            startedAt,
            embeddingModel: input.embedder.model,
            embeddingId: input.embedder.id,
            dimensions: embedding.vector.length
          }
        });
        publish(
          "sticker.search.completed",
          { resultCount: results.length },
          at
        );
        return results;
      } catch (error) {
        const at = now().toISOString();
        await log("sticker.search_failed", {
          at,
          ...(searchInput.agentTraceId
            ? { agentTraceId: searchInput.agentTraceId }
            : {}),
          data: {
            query: searchInput.query,
            limit,
            startedAt,
            error: errorMessage(error)
          }
        });
        throw error;
      }
    },

    async send(sendInput) {
      try {
        const record = await input.store.readRecord(sendInput.stickerId);
        if (!record || record.status !== "ready" || !record.desc) {
          const result = { ok: false, error: STICKER_NOT_READY_ERROR };
          await log("sticker.send_failed", {
            stickerId: sendInput.stickerId,
            conversationId: sendInput.conversation.id,
            ...(sendInput.agentTraceId
              ? { agentTraceId: sendInput.agentTraceId }
              : {}),
            data: { reason: "not_ready", error: result.error }
          });
          return result;
        }
        const at = now().toISOString();
        await log("sticker.send_attempted", {
          at,
          stickerId: record.id,
          conversationId: sendInput.conversation.id,
          ...(sendInput.agentTraceId
            ? { agentTraceId: sendInput.agentTraceId }
            : {}),
          data: { preferred: record.mface ? "mface" : "image" }
        });
        let nativeResult: ConnectorCallResult | undefined;
        if (record.mface) {
          nativeResult = await input.connector.sendSticker({
            conversation: sendInput.conversation,
            sticker: renderCqCode("mface", {
              emoji_id: record.mface.emojiId,
              emoji_package_id: record.mface.emojiPackageId,
              ...(record.mface.key ? { key: record.mface.key } : {}),
              ...(record.mface.summary
                ? { summary: record.mface.summary }
                : {})
            }),
            ...(sendInput.replyToMessageId
              ? { replyToMessageId: sendInput.replyToMessageId }
              : {})
          });
          if (nativeResult.ok) {
            await recordSendResult(
              record,
              "mface",
              nativeResult,
              false,
              sendInput
            );
            return {
              ok: true,
              ...(nativeResult.externalId
                ? { externalId: nativeResult.externalId }
                : {}),
              data: {
                stickerId: record.id,
                desc: record.desc
              }
            };
          }
          await log("sticker.send_fallback", {
            stickerId: record.id,
            conversationId: sendInput.conversation.id,
            ...(sendInput.agentTraceId
              ? { agentTraceId: sendInput.agentTraceId }
              : {}),
            data: { reason: "native_connector_rejected" }
          });
        }
        const imageBytes = await readFile(
          input.store.absolutePath(record.asset.relativePath)
        );
        const imageResult = await input.connector.sendSticker({
          conversation: sendInput.conversation,
          sticker: renderCqCode("image", {
            file: `base64://${imageBytes.toString("base64")}`,
            sub_type: 1
          }),
          ...(sendInput.replyToMessageId
            ? { replyToMessageId: sendInput.replyToMessageId }
            : {})
        });
        await recordSendResult(
          record,
          "image",
          imageResult,
          Boolean(nativeResult),
          sendInput
        );
        return imageResult.ok
          ? {
              ok: true,
              ...(imageResult.externalId
                ? { externalId: imageResult.externalId }
                : {}),
              data: {
                stickerId: record.id,
                desc: record.desc
              }
            }
          : { ok: false, error: STICKER_DELIVERY_ERROR };
      } catch {
        await log("sticker.send_failed", {
          stickerId: sendInput.stickerId,
          conversationId: sendInput.conversation.id,
          ...(sendInput.agentTraceId
            ? { agentTraceId: sendInput.agentTraceId }
            : {}),
          data: { reason: "delivery_error", error: STICKER_DELIVERY_ERROR }
        });
        return { ok: false, error: STICKER_DELIVERY_ERROR };
      }
    },

    async manage(managementInput) {
      const stickerIds = normalizeStickerManagementIds(
        managementInput.stickerIds
      );
      return enqueueManagement(async () => {
        while (workerPromise) {
          await workerPromise;
        }
        return managementInput.action === "delete"
          ? deleteStickers(stickerIds)
          : rebuildStickers(stickerIds);
      });
    },

    async snapshot(catalogInput = {}) {
      const [jobs, records, index] = await Promise.all([
        input.store.listJobs(),
        input.store.listRecords(),
        input.vectorIndex.snapshot()
      ]);
      const catalogQuery = normalizeStickerCatalogQuery(catalogInput);
      const catalogItems = records
        .map((record) => toStickerView(record, input.embedder.id))
        .filter((sticker) => matchesStickerCatalogQuery(sticker, catalogQuery));
      const recordById = new Map(records.map((record) => [record.id, record]));
      return {
        available: true,
        generatedAt: now().toISOString(),
        scraping: {
          configuredEnabled: input.configuredEnabled,
          ...(runtimeOverride !== undefined ? { runtimeOverride } : {}),
          effectiveEnabled: this.isScrapingEnabled()
        },
        processing: {
          queued: jobs.filter((job) => job.status === "queued").length,
          running: jobs.filter(
            (job) =>
              job.status !== "queued" &&
              job.status !== "ready" &&
              job.status !== "failed"
          ).length,
          failed: jobs.filter((job) => job.status === "failed").length,
          ready: records.filter((record) => record.status === "ready").length,
          duplicates: jobs.filter((job) => job.duplicate).length
        },
        embedding: {
          provider: input.embedder.provider,
          model: input.embedder.model,
          ...(index.dimensions ?? input.embedder.configuredDimensions
            ? { dimensions: index.dimensions ?? input.embedder.configuredDimensions }
            : {}),
          id: input.embedder.id,
          rowCount: index.rowCount,
          indexState: rebuildingIndex
            ? "rebuilding"
            : indexAuditError
              ? "error"
              : index.indexState,
          ...(indexAuditError ? { error: indexAuditError } : {})
        },
        jobs: jobs.slice(-200).reverse().map((job) => {
          const record = job.stickerId
            ? recordById.get(job.stickerId)
            : undefined;
          return {
            id: job.id,
            ...(job.stickerId ? { stickerId: job.stickerId } : {}),
            sourceKind: job.sourceKind,
            status: job.status,
            conversationId: job.conversation.id,
            createdAt: job.createdAt,
            updatedAt: job.updatedAt,
            stage: job.status,
            ...(job.failedStage ? { lastFailedStage: job.failedStage } : {}),
            ...(record ? { animated: record.asset.animated } : {}),
            ...(job.error ? { error: job.error } : {}),
            ...(record ? assetUrls(record) : {}),
            ...(record?.desc ? { desc: record.desc } : {})
          };
        }),
        catalog: {
          offset: catalogQuery.offset,
          limit: catalogQuery.limit,
          total: catalogItems.length
        },
        stickers: catalogItems.slice(
          catalogQuery.offset,
          catalogQuery.offset + catalogQuery.limit
        )
      };
    },

    async resolveAssetPath(stickerId, variant) {
      const record = await input.store.readRecord(stickerId);
      if (!record) {
        return undefined;
      }
      const relativePath =
        variant === "contact-sheet"
          ? record.asset.contactSheetRelativePath
          : record.asset.relativePath;
      return relativePath ? input.store.absolutePath(relativePath) : undefined;
    },

    async whenIdle() {
      while (workerPromise) {
        await workerPromise;
      }
    }
  };

  async function recordSendResult(
    record: StickerRecord,
    delivery: "mface" | "image",
    result: ConnectorCallResult,
    fallback: boolean,
    sendInput: Parameters<StickerService["send"]>[0]
  ): Promise<void> {
    const at = now().toISOString();
    await log(result.ok ? "sticker.send_completed" : "sticker.send_failed", {
      at,
      stickerId: record.id,
      conversationId: sendInput.conversation.id,
      ...(sendInput.agentTraceId ? { agentTraceId: sendInput.agentTraceId } : {}),
      data: {
        delivery,
        fallback,
        ok: result.ok,
        ...(!result.ok ? { reason: "connector_rejected" } : {}),
        ...(result.externalId ? { externalId: result.externalId } : {}),
        ...(!result.ok ? { error: STICKER_DELIVERY_ERROR } : {})
      }
    });
    publish(
      "sticker.send.completed",
      { stickerId: record.id, delivery, fallback, ok: result.ok },
      at
    );
  }

  kickWorker();
  return service;
}

function assetUrls(record: StickerRecord): {
  thumbnailUrl: string;
  contactSheetUrl?: string;
} {
  return {
    thumbnailUrl: `/api/live/stickers/assets/${encodeURIComponent(record.id)}/original`,
    ...(record.asset.contactSheetRelativePath
      ? {
          contactSheetUrl: `/api/live/stickers/assets/${encodeURIComponent(record.id)}/contact-sheet`
        }
      : {})
  };
}

function toStickerView(
  record: StickerRecord,
  embeddingId: string
): StickerView {
  const sourceKind = record.mface ? "mface" : "image";
  const embeddingStatus = !record.embedding
    ? "missing"
    : record.embedding.id === embeddingId
      ? "ready"
      : "stale";
  return {
    id: record.id,
    desc: record.desc ?? "等待分析",
    status: record.status,
    sourceKind,
    animated: record.asset.animated,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...assetUrls(record),
    embeddingStatus,
    ...(record.lastError ? { lastError: record.lastError } : {})
  };
}

export function normalizeStickerCatalogQuery(
  input: StickerCatalogQuery = {}
): NormalizedStickerCatalogQuery {
  const offset = Number.isFinite(input.offset)
    ? Math.max(0, Math.trunc(input.offset ?? 0))
    : 0;
  const requestedLimit = Number.isFinite(input.limit)
    ? Math.trunc(input.limit ?? DEFAULT_STICKER_CATALOG_LIMIT)
    : DEFAULT_STICKER_CATALOG_LIMIT;
  const status: StickerCatalogStatusFilter = [
    "ready",
    "processing",
    "failed"
  ].includes(input.status ?? "")
    ? (input.status as StickerCatalogStatusFilter)
    : "all";
  const source: StickerCatalogSourceFilter = ["mface", "image-sticker"].includes(
    input.source ?? ""
  )
    ? (input.source as StickerCatalogSourceFilter)
    : "all";
  return {
    offset,
    limit: Math.min(
      MAX_STICKER_CATALOG_LIMIT,
      Math.max(1, requestedLimit)
    ),
    query: (input.query ?? "").trim().slice(0, 256),
    status,
    source
  };
}

function matchesStickerCatalogQuery(
  sticker: StickerView,
  query: NormalizedStickerCatalogQuery
): boolean {
  const source = sticker.sourceKind === "mface" ? "mface" : "image-sticker";
  if (query.source !== "all" && source !== query.source) {
    return false;
  }
  if (query.status !== "all" && stickerCatalogStatus(sticker) !== query.status) {
    return false;
  }
  const needle = query.query.toLowerCase();
  if (!needle) {
    return true;
  }
  return [
    sticker.id,
    sticker.desc,
    sticker.sourceKind
  ].some((value) => value.toLowerCase().includes(needle));
}

function stickerCatalogStatus(
  sticker: StickerView
): Exclude<StickerCatalogStatusFilter, "all"> {
  if (sticker.status === "failed") {
    return "failed";
  }
  return sticker.status === "ready" && sticker.embeddingStatus === "ready"
    ? "ready"
    : "processing";
}

function stageLogType(status: StickerJobStatus): string {
  const names: Record<StickerJobStatus, string> = {
    queued: "sticker.job_queued",
    resolving_media: "sticker.media_resolving",
    downloading: "sticker.media_downloaded",
    rendering: "sticker.rendering_started",
    describing: "sticker.description_started",
    embedding: "sticker.embedding_started",
    indexing: "sticker.indexing_started",
    ready: "sticker.ready",
    failed: "sticker.failed"
  };
  return names[status];
}

function normalizeStickerManagementIds(
  stickerIds: readonly string[]
): string[] {
  const uniqueIds = [...new Set(stickerIds)];
  if (uniqueIds.length === 0) {
    throw new Error("At least one sticker id is required.");
  }
  if (uniqueIds.length > MAX_STICKER_MANAGEMENT_BATCH) {
    throw new Error(
      `Sticker management is limited to ${MAX_STICKER_MANAGEMENT_BATCH} records per request.`
    );
  }
  if (uniqueIds.some((stickerId) => !/^[a-zA-Z0-9_-]+$/.test(stickerId))) {
    throw new Error("Sticker management received an invalid sticker id.");
  }
  return uniqueIds;
}

function managementResponse(
  action: StickerManagementAction,
  results: StickerManagementResult[]
): StickerManagementResponse {
  const succeeded = results.filter((result) => result.ok).length;
  return {
    action,
    requested: results.length,
    succeeded,
    failed: results.length - succeeded,
    results
  };
}

function stickerAssetPaths(record: StickerRecord): string[] {
  return [
    record.asset.relativePath,
    ...(record.asset.contactSheetRelativePath
      ? [record.asset.contactSheetRelativePath]
      : [])
  ];
}

function latestJobForSticker(
  jobs: readonly StickerJob[],
  stickerId: string
): StickerJob | undefined {
  return jobs
    .filter((job) => job.stickerId === stickerId)
    .sort(
      (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
    )[0];
}

function stickerJobPlatformSummary(job: StickerJob): string | undefined {
  const summary = job.segment.data.summary;
  return summary === undefined || summary === null || String(summary).length === 0
    ? undefined
    : String(summary);
}

async function mapWithConcurrency<Input, Output>(
  values: readonly Input[],
  concurrency: number,
  mapper: (value: Input) => Promise<Output>
): Promise<Output[]> {
  const results = new Array<Output>(values.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        const value = values[index];
        if (value !== undefined) {
          results[index] = await mapper(value);
        }
      }
    }
  );
  await Promise.all(workers);
  return results;
}

function errorMessage(error: unknown): string {
  const message = redactSensitiveString(
    error instanceof Error ? error.message : String(error)
  );
  return message.length > 2000 ? `${message.slice(0, 1999)}…` : message;
}

function workerRetryDelay(consecutiveFailures: number): number {
  const exponent = Math.max(0, Math.min(16, consecutiveFailures - 1));
  return Math.min(
    WORKER_RETRY_MAX_MS,
    WORKER_RETRY_BASE_MS * 2 ** exponent
  );
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
