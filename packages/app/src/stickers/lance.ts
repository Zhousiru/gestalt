import { createHash } from "node:crypto";
import * as lancedb from "@lancedb/lancedb";

export const STICKER_VECTOR_PROJECTION_ID = "structured-visual-tags-usage";
export const STICKER_VECTOR_CHANNELS = ["visual", "tags", "usage"] as const;
export type StickerVectorChannel = (typeof STICKER_VECTOR_CHANNELS)[number];

export interface StickerVectorEntry {
  rowId: string;
  stickerId: string;
  channel: StickerVectorChannel;
  unitIndex: number;
  text: string;
  vector: number[];
  createdAt: string;
}

export interface StickerVectorSearchResult {
  rowId: string;
  stickerId: string;
  channel: StickerVectorChannel;
  unitIndex: number;
  text: string;
  distance?: number;
}

export interface StickerVectorRowIdentity {
  rowId: string;
  stickerId: string;
}

export interface StickerVectorIndexSnapshot {
  rowCount: number;
  indexState: "empty" | "ready" | "error";
  dimensions?: number;
  id: string;
  distanceMetric: typeof STICKER_DISTANCE_METRIC;
}

export interface StickerVectorIndex {
  upsert(entries: readonly StickerVectorEntry[]): Promise<void>;
  search(input: {
    vector: number[];
    channel: StickerVectorChannel;
    limit: number;
    offset?: number;
  }): Promise<StickerVectorSearchResult[]>;
  listRows(): Promise<StickerVectorRowIdentity[]>;
  listStickerIds(): Promise<string[]>;
  deleteRowIds(rowIds: readonly string[]): Promise<number>;
  deleteStickerIds(stickerIds: readonly string[]): Promise<number>;
  snapshot(): Promise<StickerVectorIndexSnapshot>;
}

const TABLE_PREFIX = "sticker_vectors_global_";
const TABLE_SUFFIX_HEX_LENGTH = 40;
export const STICKER_DISTANCE_METRIC = "cosine" as const;

export function stickerVectorIndexId(embeddingId: string): string {
  return `${embeddingId}:${STICKER_VECTOR_PROJECTION_ID}`;
}

export function stickerVectorRowId(
  stickerId: string,
  channel: StickerVectorChannel,
  unitIndex: number
): string {
  return `${stickerId}:${channel}:${unitIndex}`;
}

export async function createStickerVectorIndex(input: {
  directory: string;
  embeddingId: string;
}): Promise<StickerVectorIndex> {
  const id = stickerVectorIndexId(input.embeddingId);
  const connection = await lancedb.connect(input.directory);
  const tableName = `${TABLE_PREFIX}${tableSuffix(id)}`;
  let dimensions: number | undefined;
  let tablePromise: Promise<lancedb.Table | undefined> | undefined;

  const openTable = (): Promise<lancedb.Table | undefined> => {
    tablePromise ??= connection.tableNames().then((names) =>
      names.includes(tableName) ? connection.openTable(tableName) : undefined
    );
    return tablePromise;
  };

  return {
    async upsert(entries) {
      if (entries.length === 0) {
        return;
      }
      for (const entry of entries) {
        validateVector(entry.vector, dimensions);
        dimensions ??= entry.vector.length;
      }
      let table = await openTable();
      const rows = entries.map(toRow);
      if (!table) {
        try {
          table = await connection.createTable(tableName, rows, {
            mode: "create",
            existOk: true
          });
        } catch {
          table = await connection.openTable(tableName);
          await mergeRows(table, rows);
        }
        tablePromise = Promise.resolve(table);
        return;
      }
      await mergeRows(table, rows);
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
        .where(`channel = '${searchInput.channel}'`)
        .select([
          "row_id",
          "sticker_id",
          "channel",
          "unit_index",
          "text",
          "_distance"
        ])
        .limit(searchInput.limit);
      if (searchInput.offset) {
        query.offset(searchInput.offset);
      }
      const rows = await query.toArray();
      return rows.map((row) => ({
        rowId: String(row.row_id),
        stickerId: String(row.sticker_id),
        channel: readChannel(row.channel),
        unitIndex: Number(row.unit_index),
        text: String(row.text),
        ...(typeof row._distance === "number" ? { distance: row._distance } : {})
      }));
    },

    async listRows() {
      const table = await openTable();
      if (!table) {
        return [];
      }
      const rows = await table.query().select(["row_id", "sticker_id"]).toArray();
      return rows.map((row) => ({
        rowId: String(row.row_id),
        stickerId: String(row.sticker_id)
      }));
    },

    async listStickerIds() {
      const table = await openTable();
      if (!table) {
        return [];
      }
      const rows = await table.query().select(["sticker_id"]).toArray();
      return rows.map((row) => String(row.sticker_id));
    },

    async deleteRowIds(rowIds) {
      const table = await openTable();
      return deleteByColumn(table, "row_id", rowIds);
    },

    async deleteStickerIds(stickerIds) {
      const table = await openTable();
      return deleteByColumn(table, "sticker_id", stickerIds);
    },

    async snapshot() {
      try {
        const table = await openTable();
        if (!table) {
          return {
            rowCount: 0,
            indexState: "empty",
            id,
            distanceMetric: STICKER_DISTANCE_METRIC,
            ...(dimensions ? { dimensions } : {})
          };
        }
        const schema = await table.schema();
        const vectorField = schema.fields.find((field) => field.name === "vector");
        dimensions ??= readListSize(vectorField?.type);
        return {
          rowCount: await table.countRows(),
          indexState: "ready",
          id,
          distanceMetric: STICKER_DISTANCE_METRIC,
          ...(dimensions ? { dimensions } : {})
        };
      } catch {
        return {
          rowCount: 0,
          indexState: "error",
          id,
          distanceMetric: STICKER_DISTANCE_METRIC,
          ...(dimensions ? { dimensions } : {})
        };
      }
    }
  };
}

async function mergeRows(
  table: lancedb.Table,
  rows: Array<Record<string, unknown>>
): Promise<void> {
  await table
    .mergeInsert("row_id")
    .whenMatchedUpdateAll()
    .whenNotMatchedInsertAll()
    .execute(rows);
}

function toRow(entry: StickerVectorEntry): Record<string, unknown> {
  return {
    row_id: entry.rowId,
    sticker_id: entry.stickerId,
    channel: entry.channel,
    unit_index: entry.unitIndex,
    text: entry.text,
    vector: entry.vector,
    created_at: entry.createdAt
  };
}

async function deleteByColumn(
  table: lancedb.Table | undefined,
  column: "row_id" | "sticker_id",
  values: readonly string[]
): Promise<number> {
  const uniqueValues = [...new Set(values)];
  if (!table || uniqueValues.length === 0) {
    return 0;
  }
  let deleted = 0;
  for (const batch of chunk(uniqueValues, 256)) {
    const result = await table.delete(
      `${column} IN (${batch.map((value) => `'${escapeSql(value)}'`).join(", ")})`
    );
    deleted += result.numDeletedRows;
  }
  return deleted;
}

function readChannel(value: unknown): StickerVectorChannel {
  const channel = String(value);
  if ((STICKER_VECTOR_CHANNELS as readonly string[]).includes(channel)) {
    return channel as StickerVectorChannel;
  }
  throw new Error(`LanceDB returned an invalid sticker vector channel: ${channel}`);
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
