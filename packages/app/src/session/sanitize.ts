import { createHash } from "node:crypto";
import { readSafeRuntimeEventRaw } from "../privacy/runtimeEventMetadata";
import { sanitizeUntrustedValue } from "../privacy/stickerRedaction";

const DATA_URI_PATTERN =
  /data:([a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*);base64,([a-z0-9+/=]+)/gi;
const BASE64_URI_PATTERN = /base64:\/\/([a-z0-9+/=]+)/gi;

export function sanitizeSessionValue(value: unknown): unknown {
  // Capture binary identity before the general diagnostic redactor replaces
  // inline media with a generic label; journal rows must retain the bounded
  // MIME/length/hash descriptor promised by the storage contract.
  return sanitizeUntrustedValue(
    sanitizeBinaryRepresentations(value, {
      redactLocators: true,
      omitRawFields: false
    })
  );
}

/**
 * Keeps the connector-authorized message structure needed by the active loop,
 * but never retains connector transport `raw` trees or binary bytes in
 * SessionStore. A strict allowlist preserves only bounded correlation metadata
 * on runtime-created self events.
 * Locators remain memory-only and are removed by sanitizeSessionValue before
 * journal, diagnostics, Live, or log serialization.
 */
export function sanitizeSessionMemoryValue(value: unknown): unknown {
  return sanitizeBinaryRepresentations(value, {
    redactLocators: false,
    omitRawFields: true
  });
}

interface BinarySanitizeOptions {
  redactLocators: boolean;
  omitRawFields: boolean;
}

function sanitizeBinaryRepresentations(
  value: unknown,
  options: BinarySanitizeOptions,
  ancestors = new WeakSet<object>()
): unknown {
  if (typeof value === "string") {
    const sanitized = value
      .replace(DATA_URI_PATTERN, (_match, mediaType: string, encoded: string) =>
        renderInlineDescriptor(encoded, mediaType.toLowerCase())
      )
      .replace(BASE64_URI_PATTERN, (_match, encoded: string) =>
        renderInlineDescriptor(encoded, "application/octet-stream")
      );
    return options.redactLocators
      ? redactSessionLocators(sanitized)
      : sanitized;
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const binary = readBinaryBytes(value);
  if (binary) {
    return createBinaryDescriptor(binary, "application/octet-stream");
  }
  const record = value as Record<string, unknown>;
  const serializedBuffer = readSerializedBuffer(record);
  if (serializedBuffer) {
    return createBinaryDescriptor(serializedBuffer, "application/octet-stream");
  }
  if (ancestors.has(value)) {
    return "[Circular]";
  }
  if (value instanceof Date) {
    return value.toISOString();
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) =>
        sanitizeBinaryRepresentations(item, options, ancestors)
      );
    }
    return Object.fromEntries(
      Object.entries(record).flatMap(([key, item]) => {
        if (options.omitRawFields && key === "raw") {
          const safeRuntimeRaw = readSafeRuntimeEventRaw(record, item);
          return safeRuntimeRaw ? [[key, safeRuntimeRaw]] : [];
        }
        return [[key, sanitizeBinaryRepresentations(item, options, ancestors)]];
      })
    );
  } finally {
    ancestors.delete(value);
  }
}

function redactSessionLocators(value: string): string {
  return value
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

function renderInlineDescriptor(encoded: string, mediaType: string): string {
  const bytes = Buffer.from(encoded, "base64");
  const descriptor = createBinaryDescriptor(bytes, mediaType);
  return `[binary mediaType=${descriptor.mediaType} byteLength=${descriptor.byteLength} sha256=${descriptor.sha256} availability=not_captured]`;
}

function createBinaryDescriptor(bytes: Uint8Array, mediaType: string) {
  return {
    type: "binary",
    mediaType,
    byteLength: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    availability: "not_captured"
  } as const;
}

function readSerializedBuffer(
  value: Record<string, unknown>
): Uint8Array | undefined {
  if (
    value.type !== "Buffer" ||
    !Array.isArray(value.data) ||
    !value.data.every(
      (item) =>
        Number.isInteger(item) && Number(item) >= 0 && Number(item) <= 255
    )
  ) {
    return undefined;
  }
  return Uint8Array.from(value.data as number[]);
}

function readBinaryBytes(value: object): Uint8Array | undefined {
  if (Buffer.isBuffer(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (
    typeof SharedArrayBuffer !== "undefined" &&
    value instanceof SharedArrayBuffer
  ) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return undefined;
}
