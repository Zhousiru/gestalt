import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const pendingBlobWrites = new Map<string, Promise<void>>();

export interface HarnessBinaryReference {
  type: "binary";
  mediaType: string;
  byteLength: number;
  sha256: string;
  availability: "stored";
  artifact: string;
}

/**
 * Writes a JSON artifact after externalizing every binary representation to a
 * content-addressed `blobs/` directory beside the JSON file.
 */
export async function writeArtifactJson(
  filePath: string,
  value: unknown
): Promise<void> {
  const artifactDir = path.dirname(filePath);
  await mkdir(artifactDir, { recursive: true });
  const safeValue = await externalizeArtifactBinary(value, artifactDir);
  const serialized = JSON.stringify(safeValue, null, 2);
  if (serialized === undefined) {
    throw new TypeError(`Cannot serialize JSON artifact ${filePath}.`);
  }
  await writeFile(filePath, `${serialized}\n`, "utf8");
}

/** Externalizes every binary representation into the scenario artifact blobs/. */
export async function externalizeArtifactBinary(
  value: unknown,
  artifactDir: string
): Promise<unknown> {
  return visit(value, artifactDir, new WeakSet<object>());
}

async function visit(
  value: unknown,
  artifactDir: string,
  ancestors: WeakSet<object>
): Promise<unknown> {
  if (typeof value === "string") {
    return externalizeString(value, artifactDir, ancestors);
  }
  if (
    value === null ||
    value === undefined ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value !== "object") {
    return String(value);
  }

  const bytes = readBytes(value);
  if (bytes) {
    return store(bytes, "application/octet-stream", artifactDir);
  }
  if (ancestors.has(value)) {
    return "[Circular]";
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const result: unknown[] = [];
      for (const item of value) {
        result.push(await visit(item, artifactDir, ancestors));
      }
      return result;
    }
    const result: Record<string, unknown> = {};
    const record = value as Record<string, unknown>;
    for (const [key, item] of Object.entries(record)) {
      const hintedBinary = readHintedBase64(record, key, item);
      result[key] = hintedBinary
        ? await store(hintedBinary.bytes, hintedBinary.mediaType, artifactDir)
        : await visit(item, artifactDir, ancestors);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

async function externalizeString(
  value: string,
  artifactDir: string,
  ancestors: WeakSet<object>
): Promise<unknown> {
  const exact = decodeMedia(value);
  if (exact) {
    return store(exact.bytes, exact.mediaType, artifactDir);
  }

  const parsedContainer = parseJsonContainer(value);
  if (parsedContainer) {
    const safeContainer = await visit(parsedContainer, artifactDir, ancestors);
    return JSON.stringify(safeContainer);
  }

  const pattern = /data:([^;,\s]+)(?:;[^,]*)?;base64,([a-z0-9+/=]+)|base64:\/\/([a-z0-9+/=]+)/gi;
  let output = "";
  let cursor = 0;
  for (const match of value.matchAll(pattern)) {
    const index = match.index ?? 0;
    output += value.slice(cursor, index);
    const decoded = decodeMedia(match[0]);
    if (!decoded) {
      output += "[invalid binary media]";
    } else {
      const reference = await store(
        decoded.bytes,
        decoded.mediaType,
        artifactDir
      );
      output += `[binary artifact=${reference.artifact} mediaType=${reference.mediaType} byteLength=${reference.byteLength} sha256=${reference.sha256}]`;
    }
    cursor = index + match[0].length;
  }
  return cursor === 0 ? value : output + value.slice(cursor);
}

function parseJsonContainer(value: string): object | undefined {
  const trimmed = value.trim();
  if (
    !(
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    )
  ) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed !== null && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function readHintedBase64(
  record: Record<string, unknown>,
  key: string,
  value: unknown
): { bytes: Uint8Array; mediaType: string } | undefined {
  if (typeof value !== "string" || !isBase64(value)) {
    return undefined;
  }
  const type = typeof record.type === "string" ? record.type.toLowerCase() : "";
  const mediaType = readMediaType(record);
  const explicitlyBinaryKey = key === "base64" || key === "bytes";
  const mediaPayloadKey =
    [
      "audio",
      "body",
      "buffer",
      "content",
      "data",
      "image",
      "media",
      "payload",
      "source",
      "video"
    ].includes(key.toLowerCase()) &&
    (mediaType !== undefined ||
      ["binary", "file", "image", "audio", "video", "media"].includes(type));
  if (!explicitlyBinaryKey && !mediaPayloadKey) {
    return undefined;
  }
  return {
    bytes: Buffer.from(value, "base64"),
    mediaType: mediaType ?? "application/octet-stream"
  };
}

function readMediaType(record: Record<string, unknown>): string | undefined {
  for (const key of ["mediaType", "mimeType", "mime"]) {
    const value = record[key];
    if (typeof value === "string" && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(value)) {
      return value.toLowerCase();
    }
  }
  return undefined;
}

async function store(
  bytes: Uint8Array,
  mediaType: string,
  artifactDir: string
): Promise<HarnessBinaryReference> {
  const stable = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sha256 = createHash("sha256").update(stable).digest("hex");
  const relativePath = path.posix.join("blobs", sha256);
  const target = path.join(artifactDir, "blobs", sha256);
  const existingWrite = pendingBlobWrites.get(target);
  if (existingWrite) {
    await existingWrite;
  } else {
    const write = writeBlob(target, stable, sha256).finally(() => {
      pendingBlobWrites.delete(target);
    });
    pendingBlobWrites.set(target, write);
    await write;
  }
  return {
    type: "binary",
    mediaType,
    byteLength: stable.byteLength,
    sha256,
    availability: "stored",
    artifact: relativePath
  };
}

async function writeBlob(
  target: string,
  bytes: Buffer,
  sha256: string
): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  try {
    await writeFile(target, bytes, { flag: "wx" });
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") {
      throw error;
    }
  }
  const existing = await readFile(target);
  const existingHash = createHash("sha256").update(existing).digest("hex");
  if (existing.length !== bytes.length || existingHash !== sha256) {
    throw new Error(`Harness blob integrity mismatch for ${sha256}.`);
  }
}

function decodeMedia(
  value: string
): { bytes: Uint8Array; mediaType: string } | undefined {
  const trimmed = value.trim();
  const data = trimmed.match(
    /^data:([^;,\s]+)(?:;[^,]*)?;base64,([a-z0-9+/=]+)$/i
  );
  const oneBot = trimmed.match(/^base64:\/\/([a-z0-9+/=]+)$/i);
  const encoded = data?.[2] ?? oneBot?.[1];
  if (!encoded || !isBase64(encoded)) {
    return undefined;
  }
  return {
    bytes: Buffer.from(encoded, "base64"),
    mediaType: data?.[1]?.toLowerCase() ?? "application/octet-stream"
  };
}

function isBase64(value: string): boolean {
  if (!value || value.length % 4 === 1 || !/^[a-z0-9+/]*={0,2}$/i.test(value)) {
    return false;
  }
  const unpadded = value.replace(/=+$/, "");
  const padded = unpadded.padEnd(Math.ceil(unpadded.length / 4) * 4, "=");
  return (
    Buffer.from(padded, "base64").toString("base64").replace(/=+$/, "") ===
    unpadded
  );
}

function readBytes(value: object): Uint8Array | undefined {
  if (Buffer.isBuffer(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  const record = value as Record<string, unknown>;
  if (
    record.type === "Buffer" &&
    Array.isArray(record.data) &&
    record.data.every(
      (item) => Number.isInteger(item) && Number(item) >= 0 && Number(item) <= 255
    )
  ) {
    return Uint8Array.from(record.data as number[]);
  }
  return undefined;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
