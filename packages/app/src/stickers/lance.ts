import { createHash } from "node:crypto";
import * as lancedb from "@lancedb/lancedb";

export interface StickerVectorEntry {
  stickerId: string;
  desc: string;
  vector: number[];
  createdAt: string;
}

export interface StickerSearchResult {
  stickerId: string;
  desc: string;
  distance?: number;
}

export interface StickerVectorIndexSnapshot {
  rowCount: number;
  indexState: "empty" | "ready" | "error";
  dimensions?: number;
  id: string;
  distanceMetric: typeof STICKER_DISTANCE_METRIC;
}

export interface StickerVectorIndex {
  upsert(entry: StickerVectorEntry): Promise<void>;
  search(input: {
    vector: number[];
    limit: number;
    offset?: number;
  }): Promise<StickerSearchResult[]>;
  listStickerIds(): Promise<string[]>;
  deleteStickerIds(stickerIds: readonly string[]): Promise<number>;
  snapshot(): Promise<StickerVectorIndexSnapshot>;
}

const TABLE_PREFIX = "sticker_vectors_global_";
const TABLE_SUFFIX_HEX_LENGTH = 40;
export const STICKER_DISTANCE_METRIC = "cosine" as const;

export async function createStickerVectorIndex(input: {
  directory: string;
  embeddingId: string;
}): Promise<StickerVectorIndex> {
  const connection = await lancedb.connect(input.directory);
  const tableName = `${TABLE_PREFIX}${tableSuffix(input.embeddingId)}`;
  let dimensions: number | undefined;
  let tablePromise: Promise<lancedb.Table | undefined> | undefined;

  const openTable = (): Promise<lancedb.Table | undefined> => {
    tablePromise ??= connection.tableNames().then((names) =>
      names.includes(tableName) ? connection.openTable(tableName) : undefined
    );
    return tablePromise;
  };

  return {
    async upsert(entry) {
      validateVector(entry.vector, dimensions);
      dimensions ??= entry.vector.length;
      let table = await openTable();
      const row = toRow(entry);
      if (!table) {
        try {
          table = await connection.createTable(tableName, [row], {
            mode: "create",
            existOk: true
          });
        } catch {
          table = await connection.openTable(tableName);
          await mergeRow(table, row);
        }
        tablePromise = Promise.resolve(table);
        return;
      }
      await mergeRow(table, row);
    },

    async search(searchInput) {
      const table = await openTable();
      if (!table) {
        return [];
      }
      validateVector(searchInput.vector, dimensions);
      const query = table
        .vectorSearch(searchInput.vector)
        .distanceType(STICKER_DISTANCE_METRIC)
        .select(["sticker_id", "desc", "_distance"])
        .limit(searchInput.limit);
      if (searchInput.offset) {
        query.offset(searchInput.offset);
      }
      const rows = await query.toArray();
      return rows.map((row) => ({
        stickerId: String(row.sticker_id),
        desc: String(row.desc),
        ...(typeof row._distance === "number" ? { distance: row._distance } : {})
      }));
    },

    async listStickerIds() {
      const table = await openTable();
      if (!table) {
        return [];
      }
      const rows = await table
        .query()
        .select(["row_id"])
        .toArray();
      return rows.map((row) => String(row.row_id));
    },

    async deleteStickerIds(stickerIds) {
      const table = await openTable();
      const uniqueIds = [...new Set(stickerIds)];
      if (!table || uniqueIds.length === 0) {
        return 0;
      }
      let deleted = 0;
      for (const batch of chunk(uniqueIds, 256)) {
        const result = await table.delete(
          `row_id IN (${batch
            .map((stickerId) => `'${escapeSql(stickerId)}'`)
            .join(", ")})`
        );
        deleted += result.numDeletedRows;
      }
      return deleted;
    },

    async snapshot() {
      try {
        const table = await openTable();
        if (!table) {
          return {
            rowCount: 0,
            indexState: "empty",
            id: input.embeddingId,
            distanceMetric: STICKER_DISTANCE_METRIC,
            ...(dimensions ? { dimensions } : {})
          };
        }
        const schema = await table.schema();
        const vectorField = schema.fields.find((field) => field.name === "vector");
        const listSize = readListSize(vectorField?.type);
        dimensions ??= listSize;
        return {
          rowCount: await table.countRows(),
          indexState: "ready",
          id: input.embeddingId,
          distanceMetric: STICKER_DISTANCE_METRIC,
          ...(dimensions ? { dimensions } : {})
        };
      } catch {
        return {
          rowCount: 0,
          indexState: "error",
          id: input.embeddingId,
          distanceMetric: STICKER_DISTANCE_METRIC,
          ...(dimensions ? { dimensions } : {})
        };
      }
    }
  };
}

async function mergeRow(
  table: lancedb.Table,
  row: Record<string, unknown>
): Promise<void> {
  await table
    .mergeInsert("row_id")
    .whenMatchedUpdateAll()
    .whenNotMatchedInsertAll()
    .execute([row]);
}

function toRow(entry: StickerVectorEntry): Record<string, unknown> {
  return {
    row_id: entry.stickerId,
    sticker_id: entry.stickerId,
    desc: entry.desc,
    vector: entry.vector,
    created_at: entry.createdAt
  };
}

function validateVector(vector: number[], expected: number | undefined): void {
  if (vector.length === 0 || vector.some((value) => !Number.isFinite(value))) {
    throw new Error("Embedding model returned an empty or invalid vector.");
  }
  if (expected !== undefined && vector.length !== expected) {
    throw new Error(
      `Embedding dimensions changed from ${expected} to ${vector.length}.`
    );
  }
}

function tableSuffix(value: string): string {
  return createHash("sha256")
    .update(value)
    .digest("hex")
    .slice(0, TABLE_SUFFIX_HEX_LENGTH);
}

function escapeSql(value: string): string {
  return value.replace(/'/g, "''");
}

function chunk<T>(values: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    batches.push(values.slice(index, index + size));
  }
  return batches;
}

function readListSize(value: unknown): number | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const listSize = (value as { listSize?: unknown }).listSize;
  return typeof listSize === "number" && listSize > 0 ? listSize : undefined;
}
