import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import {
  access,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat
} from "node:fs/promises";
import type {
  BinaryDescriptor,
  BinaryWriteErrorCode,
  JsonValue
} from "./types";
import { redactSensitiveString } from "../privacy/stickerRedaction";

export const DEFAULT_MAX_TRACE_BLOB_BYTES = 16 * 1024 * 1024;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MAX_SANITIZER_DEPTH = 100;
const MEDIA_TYPE_PATTERN =
  /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;
const LOCAL_LOCATOR_KEYS = new Set([
  "file",
  "path",
  "filepath",
  "localpath",
  "temppath",
  "url",
  "uri",
  "tempurl"
]);
const EMBEDDED_DATA_MEDIA_PATTERN =
  /data:[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(?:;[^,\s]*)*;base64,[a-z0-9+/=]+/i;
const EMBEDDED_ONEBOT_BASE64_PATTERN = /base64:\/\/[a-z0-9+/=]+/i;
const BINARY_PAYLOAD_KEYS = new Set([
  "base64",
  "body",
  "buffer",
  "bytearray",
  "bytes",
  "content",
  "data",
  "image",
  "audio",
  "video",
  "media",
  "payload",
  "source"
]);
const BINARY_WRITE_ERROR_CODES = [
  "blob_directory_unavailable",
  "blob_write_failed",
  "blob_integrity_failed"
] as const;

export interface BinarySanitizerOptions {
  tracesDir: string;
  captureEnabled?: boolean;
  maxBlobBytes?: number;
  defaultMediaType?: string;
}

export interface BinarySanitizer {
  readonly captureEnabled: boolean;
  readonly maxBlobBytes: number;
  sanitize(value: unknown): Promise<JsonValue>;
  capture(bytes: Uint8Array, mediaType?: string): Promise<BinaryDescriptor>;
}

export function createBinarySanitizer(
  options: BinarySanitizerOptions
): BinarySanitizer {
  const captureEnabled = options.captureEnabled === true;
  const maxBlobBytes = normalizeMaxBlobBytes(options.maxBlobBytes);
  const defaultMediaType = normalizeMediaType(options.defaultMediaType);
  const blobStore = captureEnabled
    ? new TraceBlobStore(options.tracesDir, maxBlobBytes)
    : undefined;

  const capture = async (
    bytes: Uint8Array,
    mediaType = defaultMediaType
  ): Promise<BinaryDescriptor> => {
    // Copy before the first await so a connector cannot mutate the backing
    // buffer between hashing and the atomic write.
    const stableBytes = Buffer.from(bytes);
    const normalizedMediaType = normalizeMediaType(mediaType);
    const sha256 = createHash("sha256").update(stableBytes).digest("hex");
    const base = {
      type: "binary" as const,
      mediaType: normalizedMediaType,
      byteLength: stableBytes.byteLength,
      sha256
    };

    if (!captureEnabled || !blobStore) {
      return { ...base, availability: "not_captured" };
    }
    if (stableBytes.byteLength > maxBlobBytes) {
      return { ...base, availability: "size_limit_exceeded" };
    }
    return blobStore.store(stableBytes, base);
  };

  return {
    captureEnabled,
    maxBlobBytes,
    capture,
    async sanitize(value) {
      return sanitizeValue(value, {
        capture,
        defaultMediaType,
        ancestors: new WeakSet<object>()
      });
    }
  };
}

export async function sanitizeRolloutValue(
  value: unknown,
  options: BinarySanitizerOptions
): Promise<JsonValue> {
  return createBinarySanitizer(options).sanitize(value);
}

export function traceBlobPath(tracesDir: string, sha256: string): string {
  if (!SHA256_PATTERN.test(sha256)) {
    throw new Error("Trace blob id must be a lowercase SHA-256 digest.");
  }
  return path.join(tracesDir, "blobs", "sha256", sha256.slice(0, 2), sha256);
}

interface SanitizeContext {
  capture(
    bytes: Uint8Array,
    mediaType?: string
  ): Promise<BinaryDescriptor>;
  defaultMediaType: string;
  ancestors: WeakSet<object>;
}

async function sanitizeValue(
  value: unknown,
  context: SanitizeContext,
  mediaTypeHint?: string,
  depth = 0,
  fieldName?: string
): Promise<JsonValue> {
  if (depth > MAX_SANITIZER_DEPTH) {
    return "[MaxDepth]";
  }
  if (value === null) {
    return null;
  }
  if (typeof value === "string") {
    const data =
      decodeBase64Media(value) ??
      decodeHintedBase64(value, mediaTypeHint, fieldName);
    if (data) {
      return descriptorToJson(
        await context.capture(data.bytes, data.mediaType ?? mediaTypeHint)
      );
    }
    const parsedBinaryContainer = parseBinaryJsonContainer(
      value,
      mediaTypeHint,
      fieldName
    );
    if (parsedBinaryContainer !== undefined) {
      return sanitizeValue(
        parsedBinaryContainer,
        context,
        mediaTypeHint,
        depth + 1,
        fieldName
      );
    }
    return redactRolloutString(
      await redactEmbeddedBinary(value, context, mediaTypeHint)
    );
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }
  if (value === undefined) {
    return null;
  }
  if (typeof value === "bigint") {
    return value.toString(10);
  }
  if (typeof value === "symbol" || typeof value === "function") {
    return String(value);
  }

  const binary = bytesFromValue(value, mediaTypeHint, fieldName);
  if (binary) {
    return descriptorToJson(
      await context.capture(binary, mediaTypeHint ?? context.defaultMediaType)
    );
  }
  const existingDescriptor = readBinaryDescriptor(value);
  if (existingDescriptor) {
    return descriptorToJson(existingDescriptor);
  }
  if (context.ancestors.has(value)) {
    return "[Circular]";
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value instanceof Error) {
    context.ancestors.add(value);
    try {
      return await sanitizeError(value, context);
    } finally {
      context.ancestors.delete(value);
    }
  }

  context.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const output: JsonValue[] = [];
      for (const item of value) {
        output.push(
          await sanitizeValue(item, context, mediaTypeHint, depth + 1)
        );
      }
      return output;
    }
    if (value instanceof Map) {
      const entries = [...value.entries()].map(([key, item]) => [
        String(key),
        item
      ]);
      return sanitizeValue(
        Object.fromEntries(entries),
        context,
        mediaTypeHint,
        depth + 1
      );
    }
    if (value instanceof Set) {
      const output: JsonValue[] = [];
      for (const item of value) {
        output.push(
          await sanitizeValue(item, context, mediaTypeHint, depth + 1)
        );
      }
      return output;
    }

    const record = value as Record<string, unknown>;
    const objectMediaType = readMediaTypeHint(record) ?? mediaTypeHint;
    const output = Object.create(null) as Record<string, JsonValue>;
    for (const key of Object.keys(record)) {
      let item: unknown;
      try {
        item = record[key];
      } catch {
        output[key] = "[Unreadable]";
        continue;
      }
      if (item === undefined) {
        continue;
      }
      if (
        typeof item === "string" &&
        LOCAL_LOCATOR_KEYS.has(key.replace(/[_-]/g, "").toLowerCase())
      ) {
        const locator = sanitizeLocatorField(key, item);
        if (locator !== undefined) {
          output[key] = locator;
          continue;
        }
      }
      output[key] = await sanitizeValue(
        item,
        context,
        objectMediaType,
        depth + 1,
        key
      );
    }
    return output;
  } finally {
    context.ancestors.delete(value);
  }
}

function sanitizeLocatorField(
  key: string,
  value: string
): string | undefined {
  const normalized = key.replace(/[_-]/g, "").toLowerCase();
  // Let the binary decoder turn inline media into a descriptor.
  if (/^(?:base64:\/\/|data:[^,]+;base64,)/i.test(value.trim())) {
    return undefined;
  }
  if (
    normalized === "path" ||
    normalized === "filepath" ||
    normalized === "localpath" ||
    normalized === "temppath"
  ) {
    return "[PATH]";
  }
  if (normalized === "tempurl") {
    return "[TEMP_URL]";
  }
  if (/^file:\/\//i.test(value)) {
    return "[PATH]";
  }
  if (/^https?:\/\//i.test(value)) {
    return redactRolloutString(value);
  }
  if (
    normalized === "file" &&
    (path.isAbsolute(value) || value.includes("/") || value.includes("\\"))
  ) {
    return "[PATH]";
  }
  return redactRolloutString(value);
}

async function sanitizeError(
  error: Error,
  context: SanitizeContext
): Promise<JsonValue> {
  const output: Record<string, JsonValue> = {
    name: error.name,
    message: redactRolloutString(error.message)
  };
  if (typeof error.cause !== "undefined") {
    output.cause = await sanitizeValue(error.cause, context);
  }
  const code = (error as NodeJS.ErrnoException).code;
  if (typeof code === "string") {
    output.code = code;
  }
  return output;
}

function bytesFromValue(
  value: object,
  mediaTypeHint?: string,
  fieldName?: string
): Uint8Array | undefined {
  if (Buffer.isBuffer(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }

  if (
    mediaTypeHint &&
    isBinaryPayloadKey(fieldName) &&
    Array.isArray(value) &&
    isByteArray(value)
  ) {
    return Uint8Array.from(value);
  }

  const record = value as Record<string, unknown>;
  if (
    ["Buffer", "Uint8Array", "ArrayBuffer"].includes(String(record.type)) &&
    Array.isArray(record.data) &&
    isByteArray(record.data)
  ) {
    return Uint8Array.from(record.data as number[]);
  }
  if (
    mediaTypeHint &&
    isBinaryPayloadKey(fieldName) &&
    isSerializedTypedArray(record)
  ) {
    return Uint8Array.from(
      Object.keys(record).map((key) => Number(record[key]))
    );
  }
  return undefined;
}

function isByteArray(value: readonly unknown[]): value is number[] {
  return value.every(
    (item) => Number.isInteger(item) && Number(item) >= 0 && Number(item) <= 255
  );
}

function isSerializedTypedArray(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  return (
    keys.length > 0 &&
    keys.every((key, index) => key === String(index)) &&
    keys.every((key) => {
      const item = value[key];
      return Number.isInteger(item) && Number(item) >= 0 && Number(item) <= 255;
    })
  );
}

function decodeBase64Media(
  value: string
): { bytes: Uint8Array; mediaType?: string } | undefined {
  const trimmed = value.trim();
  const dataUri = trimmed.match(
    /^data:([^;,\s]+)(?:;[^,]*)?;base64,([a-z0-9+/=\s]+)$/i
  );
  if (dataUri?.[2]) {
    const encoded = dataUri[2].replace(/\s+/g, "");
    if (!isCanonicalBase64(encoded)) {
      return undefined;
    }
    return {
      bytes: Buffer.from(encoded, "base64"),
      ...(dataUri[1] ? { mediaType: normalizeMediaType(dataUri[1]) } : {})
    };
  }

  const oneBotBase64 = trimmed.match(/^base64:\/\/([a-z0-9+/=\s]+)$/i);
  if (!oneBotBase64?.[1]) {
    return undefined;
  }
  const encoded = oneBotBase64[1].replace(/\s+/g, "");
  if (!isCanonicalBase64(encoded)) {
    return undefined;
  }
  return { bytes: Buffer.from(encoded, "base64") };
}

function decodeHintedBase64(
  value: string,
  mediaTypeHint?: string,
  fieldName?: string
): { bytes: Uint8Array; mediaType: string } | undefined {
  if (!mediaTypeHint || !isBinaryPayloadKey(fieldName)) {
    return undefined;
  }
  const encoded = value.trim().replace(/\s+/g, "");
  return isPlausibleBareBase64(encoded, mediaTypeHint)
    ? { bytes: Buffer.from(encoded, "base64"), mediaType: mediaTypeHint }
    : undefined;
}

function isPlausibleBareBase64(value: string, mediaType: string): boolean {
  return (
    !mediaType.toLowerCase().startsWith("text/") &&
    (value.includes("=") || value.length >= 16) &&
    isCanonicalBase64(value)
  );
}

function isBinaryPayloadKey(value: string | undefined): boolean {
  return value
    ? BINARY_PAYLOAD_KEYS.has(value.replace(/[_-]/g, "").toLowerCase())
    : false;
}

function parseBinaryJsonContainer(
  value: string,
  mediaTypeHint?: string,
  fieldName?: string
): unknown | undefined {
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
    return containsBinaryRepresentation(parsed, mediaTypeHint, fieldName)
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

function containsBinaryRepresentation(
  value: unknown,
  mediaTypeHint?: string,
  fieldName?: string,
  depth = 0
): boolean {
  if (depth > MAX_SANITIZER_DEPTH || value === null || value === undefined) {
    return false;
  }
  if (typeof value === "string") {
    return (
      decodeBase64Media(value) !== undefined ||
      decodeHintedBase64(value, mediaTypeHint, fieldName) !== undefined ||
      EMBEDDED_DATA_MEDIA_PATTERN.test(value) ||
      EMBEDDED_ONEBOT_BASE64_PATTERN.test(value)
    );
  }
  if (typeof value !== "object") {
    return false;
  }
  if (bytesFromValue(value, mediaTypeHint, fieldName)) {
    return true;
  }
  const record = value as Record<string, unknown>;
  const objectMediaType = readMediaTypeHint(record) ?? mediaTypeHint;
  return Object.entries(record).some(([key, item]) =>
    containsBinaryRepresentation(item, objectMediaType, key, depth + 1)
  );
}

function isCanonicalBase64(value: string): boolean {
  if (!value || value.length % 4 === 1 || !/^[a-z0-9+/]*={0,2}$/i.test(value)) {
    return false;
  }
  try {
    const unpadded = value.replace(/=+$/, "");
    const padded = unpadded.padEnd(Math.ceil(unpadded.length / 4) * 4, "=");
    return (
      Buffer.from(padded, "base64").toString("base64").replace(/=+$/, "") ===
      unpadded
    );
  } catch {
    return false;
  }
}

async function redactEmbeddedBinary(
  value: string,
  context: SanitizeContext,
  mediaTypeHint?: string
): Promise<string> {
  const pattern = new RegExp(
    `${EMBEDDED_DATA_MEDIA_PATTERN.source}|${EMBEDDED_ONEBOT_BASE64_PATTERN.source}`,
    "gi"
  );
  let output = "";
  let cursor = 0;
  for (const match of value.matchAll(pattern)) {
    const index = match.index ?? 0;
    output += value.slice(cursor, index);
    const decoded = decodeBase64Media(match[0]);
    if (!decoded) {
      output += "[binary media omitted]";
    } else {
      const descriptor = await context.capture(
        decoded.bytes,
        decoded.mediaType ?? mediaTypeHint
      );
      output += `[binary mediaType=${descriptor.mediaType} byteLength=${descriptor.byteLength} sha256=${descriptor.sha256} availability=${descriptor.availability}]`;
    }
    cursor = index + match[0].length;
  }
  return cursor === 0 ? value : output + value.slice(cursor);
}

function redactRolloutString(value: string): string {
  return redactSensitiveString(value, { redactUrls: false })
    .replace(/file:\/\/\/[^\s"',<>\]]+/gi, "[PATH]")
    .replace(/\\\\[^\s"',<>\]]+/g, "[PATH]")
    .replace(/\b[A-Za-z]:\\[^\s"',<>\]]+/g, "[PATH]")
    .replace(
      /\/(?:home|Users|tmp|var|opt|root|mnt)\/[^\s"',<>\]]+/g,
      "[PATH]"
    )
    .replace(/https?:\/\/[^\s"',<>\]]+/gi, (url) =>
      /[?&](?:token|sig|signature|expires|auth|key|x-amz-[^=]*)=/i.test(url)
        ? "[TEMP_URL]"
        : url
    );
}

function readMediaTypeHint(
  value: Record<string, unknown>
): string | undefined {
  for (const key of ["mediaType", "mimeType", "contentType", "mime_type"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && MEDIA_TYPE_PATTERN.test(candidate.trim())) {
      return normalizeMediaType(candidate);
    }
  }
  return undefined;
}

function normalizeMediaType(value?: string): string {
  const candidate = value?.split(";", 1)[0]?.trim().toLowerCase();
  return candidate && MEDIA_TYPE_PATTERN.test(candidate)
    ? candidate
    : "application/octet-stream";
}

function normalizeMaxBlobBytes(value?: number): number {
  if (value === undefined) {
    return DEFAULT_MAX_TRACE_BLOB_BYTES;
  }
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("maxBlobBytes must be a positive safe integer.");
  }
  return value;
}

function readBinaryDescriptor(value: object): BinaryDescriptor | undefined {
  const candidate = value as Partial<BinaryDescriptor>;
  if (
    candidate.type !== "binary" ||
    typeof candidate.mediaType !== "string" ||
    normalizeMediaType(candidate.mediaType) !==
      candidate.mediaType.trim().toLowerCase() ||
    typeof candidate.byteLength !== "number" ||
    !Number.isSafeInteger(candidate.byteLength) ||
    candidate.byteLength < 0 ||
    typeof candidate.sha256 !== "string" ||
    !SHA256_PATTERN.test(candidate.sha256) ||
    ![
      "stored",
      "not_captured",
      "size_limit_exceeded",
      "write_failed"
    ].includes(candidate.availability ?? "")
  ) {
    return undefined;
  }
  if (
    candidate.errorCode !== undefined &&
    !BINARY_WRITE_ERROR_CODES.includes(candidate.errorCode)
  ) {
    return undefined;
  }
  return candidate as BinaryDescriptor;
}

function descriptorToJson(
  descriptor: BinaryDescriptor
): Record<string, JsonValue> {
  return {
    type: descriptor.type,
    mediaType: descriptor.mediaType,
    byteLength: descriptor.byteLength,
    sha256: descriptor.sha256,
    availability: descriptor.availability,
    ...(descriptor.errorCode ? { errorCode: descriptor.errorCode } : {})
  };
}

class TraceBlobStore {
  constructor(
    private readonly tracesDir: string,
    private readonly maxBlobBytes: number
  ) {}

  async store(
    bytes: Uint8Array,
    identity: Omit<BinaryDescriptor, "availability" | "errorCode">
  ): Promise<BinaryDescriptor> {
    if (bytes.byteLength > this.maxBlobBytes) {
      return { ...identity, availability: "size_limit_exceeded" };
    }

    const target = traceBlobPath(this.tracesDir, identity.sha256);
    const directory = path.dirname(target);
    try {
      await mkdir(directory, { recursive: true });
    } catch {
      return writeFailed(identity, "blob_directory_unavailable");
    }

    const existing = await verifyExistingBlob(target, identity);
    if (existing === "valid") {
      return { ...identity, availability: "stored" };
    }
    if (existing === "invalid") {
      return writeFailed(identity, "blob_integrity_failed");
    }

    const temporary = path.join(
      directory,
      `.${identity.sha256}.${process.pid}.${randomUUID()}.tmp`
    );
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      const info = await handle.stat();
      if (info.size !== identity.byteLength) {
        return writeFailed(identity, "blob_integrity_failed");
      }
      await handle.close();
      handle = undefined;

      try {
        await rename(temporary, target);
      } catch (error) {
        if (await pathExists(target)) {
          const raced = await verifyExistingBlob(target, identity);
          if (raced === "valid") {
            return { ...identity, availability: "stored" };
          }
          return writeFailed(identity, "blob_integrity_failed");
        }
        throw error;
      }
      return { ...identity, availability: "stored" };
    } catch {
      return writeFailed(identity, "blob_write_failed");
    } finally {
      await handle?.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}

async function verifyExistingBlob(
  filePath: string,
  identity: Omit<BinaryDescriptor, "availability" | "errorCode">
): Promise<"missing" | "valid" | "invalid"> {
  try {
    const info = await stat(filePath);
    if (!info.isFile() || info.size !== identity.byteLength) {
      return "invalid";
    }
    const bytes = await readFile(filePath);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    return sha256 === identity.sha256 ? "valid" : "invalid";
  } catch (error) {
    return isNodeError(error) && error.code === "ENOENT" ? "missing" : "invalid";
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function writeFailed(
  identity: Omit<BinaryDescriptor, "availability" | "errorCode">,
  errorCode: BinaryWriteErrorCode
): BinaryDescriptor {
  return { ...identity, availability: "write_failed", errorCode };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
