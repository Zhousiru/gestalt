import path from "node:path";
import { mkdir, open } from "node:fs/promises";
import type { GestaltHome } from "../home/resolveGestaltHome";
import {
  SessionJournalRecordSchema,
  type SessionJournalRecord
} from "./schemas";
import { sanitizeSessionValue } from "./sanitize";

export const SESSION_JOURNAL_FILE_NAME = "000001.jsonl";
export const SESSION_JOURNAL_BATCH_INTERVAL_MS = 250;
export const SESSION_JOURNAL_BATCH_RECORDS = 256;
export const SESSION_JOURNAL_BATCH_BYTES = 1 * 1_024 * 1_024;
export const SESSION_JOURNAL_BUFFER_BYTES = 4 * 1_024 * 1_024;

export interface SessionRecorderFlushOptions {
  durable?: boolean;
}

export interface SessionRecorderStats {
  bufferedBytes: number;
  queuedBytes: number;
  queuedRecords: number;
  pendingRecords: number;
  waitingProducers: number;
  draining: boolean;
  failed: boolean;
}

export interface SessionRecorder {
  /** Callers must await enqueue before accepting more input to honor backpressure. */
  enqueue(record: SessionJournalRecord): Promise<void>;
  flush(options?: SessionRecorderFlushOptions): Promise<void>;
  getStats(): SessionRecorderStats;
}

interface PendingRecord {
  filePath: string;
  line: string;
  bytes: number;
  completion: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
}

interface CapacityWaiter {
  resolve: () => void;
  reject: (error: unknown) => void;
}

export function createSessionRecorder(home: GestaltHome): SessionRecorder {
  const queue: PendingRecord[] = [];
  const pendingCompletions = new Set<Promise<void>>();
  const capacityWaiters = new Set<CapacityWaiter>();
  const dirtyFiles = new Map<string, number>();
  let bufferedBytes = 0;
  let queuedBytes = 0;
  let flushTimer: NodeJS.Timeout | undefined;
  let draining: Promise<void> | undefined;
  let writeError: unknown;

  return {
    enqueue(value) {
      const record = SessionJournalRecordSchema.parse(
        sanitizeSessionValue(value)
      );
      const line = `${JSON.stringify(record)}\n`;
      const bytes = Buffer.byteLength(line, "utf8");
      if (bytes > SESSION_JOURNAL_BUFFER_BYTES) {
        return Promise.reject(
          new Error(
            `Session journal record is ${bytes} bytes, exceeding the ${SESSION_JOURNAL_BUFFER_BYTES}-byte buffer limit.`
          )
        );
      }
      return enqueueWithBackpressure({
        filePath: resolveSessionJournalFile(
          home.sessionsDir,
          record.recordedAt
        ),
        line,
        bytes
      });
    },

    async flush(options = {}) {
      if (writeError !== undefined) {
        throw writeError;
      }
      const completions = Array.from(pendingCompletions);
      startDrain();
      await Promise.all(completions);
      if (writeError !== undefined) {
        throw writeError;
      }
      if (options.durable) {
        const filesToSync = Array.from(dirtyFiles.entries());
        try {
          await syncFiles(filesToSync.map(([filePath]) => filePath));
        } catch (error) {
          failWriter(error);
          throw error;
        }
        for (const [filePath, generation] of filesToSync) {
          if (dirtyFiles.get(filePath) === generation) {
            dirtyFiles.delete(filePath);
          }
        }
      }
    },

    getStats() {
      return {
        bufferedBytes,
        queuedBytes,
        queuedRecords: queue.length,
        pendingRecords: pendingCompletions.size,
        waitingProducers: capacityWaiters.size,
        draining: draining !== undefined,
        failed: writeError !== undefined
      };
    }
  };

  async function enqueueWithBackpressure(input: {
    filePath: string;
    line: string;
    bytes: number;
  }): Promise<void> {
    while (bufferedBytes + input.bytes > SESSION_JOURNAL_BUFFER_BYTES) {
      await waitForCapacity();
    }
    if (writeError !== undefined) {
      throw writeError;
    }

    let resolveCompletion!: () => void;
    let rejectCompletion!: (error: unknown) => void;
    const completion = new Promise<void>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    const pending: PendingRecord = {
      ...input,
      completion,
      resolve: resolveCompletion,
      reject: rejectCompletion
    };
    queue.push(pending);
    bufferedBytes += pending.bytes;
    queuedBytes += pending.bytes;
    pendingCompletions.add(completion);
    void completion
      .catch(() => undefined)
      .finally(() => pendingCompletions.delete(completion));

    if (
      queue.length >= SESSION_JOURNAL_BATCH_RECORDS ||
      queuedBytes >= SESSION_JOURNAL_BATCH_BYTES
    ) {
      startDrain();
    } else {
      scheduleDrain();
    }
  }

  function waitForCapacity(): Promise<void> {
    if (writeError !== undefined) {
      return Promise.reject(writeError);
    }
    return new Promise<void>((resolve, reject) => {
      capacityWaiters.add({ resolve, reject });
    });
  }

  function scheduleDrain(): void {
    if (flushTimer || draining || queue.length === 0) {
      return;
    }
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      startDrain();
    }, SESSION_JOURNAL_BATCH_INTERVAL_MS);
    flushTimer.unref?.();
  }

  function startDrain(): void {
    if (draining || queue.length === 0 || writeError !== undefined) {
      return;
    }
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
    draining = drainQueue()
      .catch((error: unknown) => {
        failWriter(error);
      })
      .finally(() => {
        draining = undefined;
        if (queue.length > 0 && writeError === undefined) {
          scheduleDrain();
        }
      });
  }

  async function drainQueue(): Promise<void> {
    while (queue.length > 0) {
      const batch = takeBatch();
      try {
        await writeBatch(batch);
      } catch (error) {
        for (const pending of batch) {
          bufferedBytes -= pending.bytes;
          pending.reject(error);
        }
        notifyCapacity();
        throw error;
      }
      for (const pending of batch) {
        bufferedBytes -= pending.bytes;
        pending.resolve();
      }
      notifyCapacity();
    }
  }

  function takeBatch(): PendingRecord[] {
    const batch: PendingRecord[] = [];
    let batchBytes = 0;
    while (queue.length > 0 && batch.length < SESSION_JOURNAL_BATCH_RECORDS) {
      const next = queue[0];
      if (
        !next ||
        (batch.length > 0 &&
          batchBytes + next.bytes > SESSION_JOURNAL_BATCH_BYTES)
      ) {
        break;
      }
      queue.shift();
      queuedBytes -= next.bytes;
      batch.push(next);
      batchBytes += next.bytes;
    }
    return batch;
  }

  async function writeBatch(batch: readonly PendingRecord[]): Promise<void> {
    const linesByFile = new Map<string, string[]>();
    for (const pending of batch) {
      const lines = linesByFile.get(pending.filePath) ?? [];
      lines.push(pending.line);
      linesByFile.set(pending.filePath, lines);
    }

    for (const [filePath, lines] of linesByFile) {
      await mkdir(path.dirname(filePath), { recursive: true });
      const handle = await open(filePath, "a");
      try {
        await handle.writeFile(lines.join(""), "utf8");
      } finally {
        await handle.close();
      }
      dirtyFiles.set(filePath, (dirtyFiles.get(filePath) ?? 0) + 1);
    }
  }

  function notifyCapacity(): void {
    const waiters = Array.from(capacityWaiters);
    capacityWaiters.clear();
    for (const waiter of waiters) {
      waiter.resolve();
    }
  }

  function failWriter(error: unknown): void {
    writeError ??= error;
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
    for (const pending of queue.splice(0)) {
      bufferedBytes -= pending.bytes;
      queuedBytes -= pending.bytes;
      pending.reject(writeError);
    }
    const waiters = Array.from(capacityWaiters);
    capacityWaiters.clear();
    for (const waiter of waiters) {
      waiter.reject(writeError);
    }
  }
}

export function resolveSessionJournalFile(
  sessionsDir: string,
  timestamp: string
): string {
  const parsedTimestamp = new Date(timestamp);
  if (Number.isNaN(parsedTimestamp.valueOf())) {
    throw new Error(`Invalid session journal timestamp: ${timestamp}`);
  }
  const day = parsedTimestamp.toISOString().slice(0, 10);
  return path.join(sessionsDir, "journal", day, SESSION_JOURNAL_FILE_NAME);
}

async function syncFiles(filePaths: readonly string[]): Promise<void> {
  for (const filePath of filePaths) {
    const handle = await open(filePath, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}
