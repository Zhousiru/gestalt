import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  writeFile
} from "node:fs/promises";
import type { GestaltHome } from "../home/resolveGestaltHome";
import {
  StickerJobSchema,
  StickerRecordSchema,
  type StickerJob,
  type StickerJobStatus,
  type StickerObservation,
  type StickerRecord
} from "./schemas";

export interface StickerStore {
  createJob(observation: StickerObservation, at: string): Promise<StickerJob>;
  listJobs(): Promise<StickerJob[]>;
  readJob(id: string): Promise<StickerJob | undefined>;
  updateJob(
    id: string,
    update: Partial<
      Pick<StickerJob, "stickerId" | "duplicate" | "failedStage" | "error">
    > & {
      status?: StickerJobStatus;
      attempts?: number;
      updatedAt: string;
    }
  ): Promise<StickerJob>;
  listRecords(): Promise<StickerRecord[]>;
  readRecord(id: string): Promise<StickerRecord | undefined>;
  findRecordBySha256(sha256: string): Promise<StickerRecord | undefined>;
  saveRecord(record: StickerRecord): Promise<void>;
  saveBlob(sha256: string, extension: string, bytes: Uint8Array): Promise<string>;
  absolutePath(relativePath: string): string;
}

export function createStickerStore(home: GestaltHome): StickerStore {
  const jobsById = new Map<string, StickerJob>();
  const recordsById = new Map<string, StickerRecord>();
  let allJobsLoaded = false;
  let allRecordsLoaded = false;
  let jobsLoadPromise: Promise<void> | undefined;
  let recordsLoadPromise: Promise<void> | undefined;
  let sortedJobs: StickerJob[] | undefined;
  let sortedRecords: StickerRecord[] | undefined;

  const ensureAllJobsLoaded = async (): Promise<void> => {
    if (allJobsLoaded) {
      return;
    }
    jobsLoadPromise ??= readSchemaDirectory(
      home.stickerJobsDir,
      StickerJobSchema
    )
      .then((jobs) => {
        for (const job of jobs) {
          if (!jobsById.has(job.id)) {
            jobsById.set(job.id, job);
          }
        }
        allJobsLoaded = true;
        sortedJobs = undefined;
      })
      .catch((error: unknown) => {
        jobsLoadPromise = undefined;
        throw error;
      });
    await jobsLoadPromise;
  };

  const ensureAllRecordsLoaded = async (): Promise<void> => {
    if (allRecordsLoaded) {
      return;
    }
    recordsLoadPromise ??= readSchemaDirectory(
      home.stickerRecordsDir,
      StickerRecordSchema
    )
      .then((records) => {
        for (const record of records) {
          if (!recordsById.has(record.id)) {
            recordsById.set(record.id, record);
          }
        }
        allRecordsLoaded = true;
        sortedRecords = undefined;
      })
      .catch((error: unknown) => {
        recordsLoadPromise = undefined;
        throw error;
      });
    await recordsLoadPromise;
  };

  const readJob = async (id: string): Promise<StickerJob | undefined> => {
    const cached = jobsById.get(id);
    if (cached) {
      return cached;
    }
    if (jobsLoadPromise) {
      await jobsLoadPromise;
      return jobsById.get(id);
    }
    const job = await readOptionalJson(jobPath(home, id), StickerJobSchema);
    if (job) {
      jobsById.set(job.id, job);
    }
    return job;
  };

  const readRecord = async (id: string): Promise<StickerRecord | undefined> => {
    const cached = recordsById.get(id);
    if (cached) {
      return cached;
    }
    if (recordsLoadPromise) {
      await recordsLoadPromise;
      return recordsById.get(id);
    }
    const record = await readOptionalJson(
      recordPath(home, id),
      StickerRecordSchema
    );
    if (record) {
      recordsById.set(record.id, record);
    }
    return record;
  };

  return {
    async createJob(observation, at) {
      const job = StickerJobSchema.parse({
        id: randomUUID(),
        status: "queued",
        sourceKind: observation.sourceKind,
        eventId: observation.eventId,
        messageId: observation.messageId,
        conversation: observation.conversation,
        senderId: observation.senderId,
        occurredAt: observation.occurredAt,
        segmentIndex: observation.segmentIndex,
        segment: observation.segment,
        createdAt: at,
        updatedAt: at,
        attempts: 0
      });
      await writeJsonAtomic(jobPath(home, job.id), job);
      jobsById.set(job.id, job);
      sortedJobs = undefined;
      return job;
    },

    async listJobs() {
      await ensureAllJobsLoaded();
      sortedJobs ??= [...jobsById.values()].sort(
        (left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt)
      );
      return [...sortedJobs];
    },

    readJob,

    async updateJob(id, update) {
      await ensureAllJobsLoaded();
      const current = jobsById.get(id);
      if (!current) {
        throw new Error(`Sticker job ${id} does not exist.`);
      }
      const next = StickerJobSchema.parse({ ...current, ...update });
      await writeJsonAtomic(jobPath(home, id), next);
      jobsById.set(next.id, next);
      if (sortedJobs) {
        sortedJobs = sortedJobs.map((job) =>
          job.id === next.id ? next : job
        );
      }
      return next;
    },

    async listRecords() {
      await ensureAllRecordsLoaded();
      sortedRecords ??= [...recordsById.values()].sort(
        (left, right) =>
          Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
          left.id.localeCompare(right.id)
      );
      return [...sortedRecords];
    },

    readRecord,

    async findRecordBySha256(sha256) {
      const records = await this.listRecords();
      return records.find((record) => record.asset.sha256 === sha256);
    },

    async saveRecord(record) {
      await ensureAllRecordsLoaded();
      const parsed = StickerRecordSchema.parse(record);
      await writeJsonAtomic(recordPath(home, parsed.id), parsed);
      recordsById.set(parsed.id, parsed);
      sortedRecords = undefined;
    },

    async saveBlob(sha256, extension, bytes) {
      const safeExtension = extension.replace(/[^a-z0-9]/gi, "").toLowerCase() || "bin";
      const absolute = path.join(home.stickerBlobsDir, `${sha256}.${safeExtension}`);
      try {
        const existing = await stat(absolute);
        if (existing.isFile()) {
          return toRelative(home, absolute);
        }
      } catch {
        // The content-addressed blob does not exist yet.
      }
      await mkdir(home.stickerBlobsDir, { recursive: true });
      await writeFile(absolute, bytes, { flag: "wx" }).catch(async (error: unknown) => {
        if (!isNodeError(error) || error.code !== "EEXIST") {
          throw error;
        }
      });
      return toRelative(home, absolute);
    },

    absolutePath(relativePath) {
      const absolute = path.resolve(home.root, relativePath);
      const within = path.relative(home.root, absolute);
      if (within.startsWith("..") || path.isAbsolute(within)) {
        throw new Error("Sticker path escapes GestaltHome.");
      }
      return absolute;
    }
  };
}

async function readSchemaDirectory<T>(
  directory: string,
  schema: { parse(value: unknown): T }
): Promise<T[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const values = await Promise.all(
    names
      .filter((name) => name.endsWith(".json"))
      .map((name) => readOptionalJson(path.join(directory, name), schema))
  );
  const parsed: T[] = [];
  for (const value of values) {
    if (value !== undefined) {
      parsed.push(value);
    }
  }
  return parsed;
}

async function readOptionalJson<T>(
  filePath: string,
  schema: { parse(value: unknown): T }
): Promise<T | undefined> {
  try {
    return schema.parse(JSON.parse(await readFile(filePath, "utf8")));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, filePath);
}

function jobPath(home: GestaltHome, id: string): string {
  return path.join(home.stickerJobsDir, `${safeId(id)}.json`);
}

function recordPath(home: GestaltHome, id: string): string {
  return path.join(home.stickerRecordsDir, `${safeId(id)}.json`);
}

function safeId(id: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error(`Invalid sticker store id: ${id}`);
  }
  return id;
}

function toRelative(home: GestaltHome, absolute: string): string {
  return path.relative(home.root, absolute).split(path.sep).join("/");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
