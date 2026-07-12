import { createHash } from "node:crypto";
import type { MessageReceivedEvent } from "../events/schemas";

export function visibleMessageText(
  event: MessageReceivedEvent,
  options: { preferRaw?: boolean } = {}
): string {
  return options.preferRaw
    ? (event.message.rawText ?? event.message.text)
    : event.message.text;
}

/** Redacts secrets while preserving non-binary CQ control markup. */
export function redactSensitiveString(
  value: string,
  options: { redactUrls?: boolean } = {}
): string {
  const cq: string[] = [];
  // CQ control markup remains inspectable, but binary-bearing attribute values
  // must be removed before the markup is protected from generic redaction.
  const protectedValue = redactInlineBinaryMedia(value).replace(
    /\[CQ:[A-Za-z0-9_-]+(?:,[^\]]*)?\]/g,
    (markup) => {
      const index = cq.push(markup) - 1;
      return `\uE000CQ${index}\uE001`;
    }
  );
  let redacted = protectedValue
    .replace(/base64:\/\/[A-Za-z0-9+/=]+/gi, "[表情数据]")
    .replace(
      /data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi,
      "[表情数据]"
    )
    .replace(/file:\/\/\/[^\s"'<>\]]+/gi, "[PATH]")
    .replace(/(["'])(?:[A-Za-z]:\\|\\\\)[^"'\r\n]+\1/g, "[PATH]")
    .replace(
      /(["'])\/(?:home|Users|tmp|var|opt|root|mnt)\/[^"'\r\n]+\1/g,
      "[PATH]"
    )
    // Diagnostic previews are sometimes JSON serialized before they reach the
    // trace boundary. Redact an absolute POSIX locator by its field name so
    // connector-specific roots such as /mock or /run cannot bypass the small
    // well-known-directory patterns below.
    .replace(
      /((?:"(?:file|path|filepath|localpath|temppath)"|'(?:file|path|filepath|localpath|temppath)')\s*:\s*["'])\/[^"'\r\n]+(["'])/gi,
      "$1[PATH]$2"
    )
    .replace(/\\\\[^\s"'<>\]]+/g, "[PATH]")
    .replace(/\b[A-Za-z]:\\[^\s"'<>\]]+/g, "[PATH]")
    .replace(/\/(?:home|Users|tmp|var|opt|root|mnt)\/[^\s"'<>\]]+/g, "[PATH]")
    .replace(
      /(\bauthorization\b["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n]+)/gi,
      "$1[REDACTED]"
    )
    .replace(
      /(["']?(?:key|api[_-]?key)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^,\s}\]]+)/gi,
      "$1[REDACTED]"
    );
  if (options.redactUrls !== false) {
    redacted = redacted.replace(/https?:\/\/[^\s"'<>\]]+/gi, "[URL]");
  }
  return redacted.replace(/\uE000CQ(\d+)\uE001/g, (_token, index) =>
    cq[Number(index)] ?? ""
  );
}

function redactInlineBinaryMedia(value: string): string {
  return value
    .replace(/base64:\/\/[A-Za-z0-9+/=]+/gi, "[表情数据]")
    .replace(
      /data:[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*(?:;[^,\]\s;]+)*;base64,[A-Za-z0-9+/=]+/gi,
      "[表情数据]"
    );
}

/**
 * Converts internal/runtime values into a diagnostic-output-safe JSON value.
 * Canonical replay remains outside this diagnostic boundary. Live CQ structure
 * stays inspectable, while binary payloads, transport data, paths, and API keys
 * are removed.
 */
export function sanitizeUntrustedValue(
  value: unknown,
  options: { redactUrls?: boolean } = {}
): unknown {
  return sanitizeValue(
    value,
    new WeakSet<object>(),
    options.redactUrls === true,
    false
  );
}

function sanitizeValue(
  value: unknown,
  seen: WeakSet<object>,
  redactUrls: boolean,
  inheritedStickerTransport: boolean
): unknown {
  if (typeof value === "string") {
    return redactSensitiveString(value, { redactUrls });
  }
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === undefined
  ) {
    return value;
  }
  if (typeof value !== "object") {
    return String(value);
  }
  const binary = readBinaryBytes(value);
  if (binary) {
    return {
      type: "binary",
      mediaType: "application/octet-stream",
      byteLength: binary.byteLength,
      sha256: createHash("sha256").update(binary).digest("hex"),
      availability: "not_captured"
    };
  }
  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);
  if (Array.isArray(value)) {
    const sanitized = value.map((item) =>
      sanitizeValue(
        item,
        seen,
        redactUrls,
        inheritedStickerTransport
      )
    );
    seen.delete(value);
    return sanitized;
  }

  const input = value as Record<string, unknown>;
  const stickerTransportObject =
    inheritedStickerTransport || isStickerTransportObject(input);
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(input)) {
    const safeBinaryMedia = key === "media" && containsBinaryDescriptor(item);
    if (
      key === "raw" ||
      key === "sourceContent" ||
      key === "segment" ||
      key === "segments" ||
      (key === "media" && !safeBinaryMedia) ||
      key === "vector" ||
      key === "api_key" ||
      key === "apiKey" ||
      key.toLowerCase() === "authorization" ||
      (stickerTransportObject &&
        (key === "key" ||
          key === "emoji_id" ||
          key === "emojiId" ||
          key === "emoji_package_id" ||
          key === "emojiPackageId"))
    ) {
      continue;
    }
    if (
      (key === "text" || key === "rawText" || key === "raw_message") &&
      typeof item === "string"
    ) {
      output[key] = redactSensitiveString(item, { redactUrls });
      continue;
    }
    if (
      (key === "file" || key === "path") &&
      typeof item === "string" &&
      isAbsoluteLocalPath(item)
    ) {
      output[key] = "[PATH]";
      continue;
    }
    output[key] = sanitizeValue(
      item,
      seen,
      redactUrls ||
        stickerTransportObject ||
        safeBinaryMedia ||
        isDiagnosticStringKey(key),
      stickerTransportObject
    );
  }
  seen.delete(value);
  return output;
}

function readBinaryBytes(value: object): Uint8Array | undefined {
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return undefined;
}

function containsBinaryDescriptor(
  value: unknown,
  seen = new WeakSet<object>(),
  depth = 0
): boolean {
  if (!value || typeof value !== "object" || depth > 20) {
    return false;
  }
  if (seen.has(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (
    record.type === "binary" &&
    typeof record.mediaType === "string" &&
    typeof record.byteLength === "number" &&
    Number.isSafeInteger(record.byteLength) &&
    record.byteLength >= 0 &&
    typeof record.sha256 === "string" &&
    /^[a-f0-9]{64}$/i.test(record.sha256) &&
    [
      "stored",
      "not_captured",
      "size_limit_exceeded",
      "write_failed"
    ].includes(String(record.availability))
  ) {
    return true;
  }
  seen.add(value);
  try {
    return (Array.isArray(value) ? value : Object.values(record)).some((item) =>
      containsBinaryDescriptor(item, seen, depth + 1)
    );
  } finally {
    seen.delete(value);
  }
}

function isDiagnosticStringKey(key: string): boolean {
  return ["error", "lastError", "reason", "preview", "dataPreview"].includes(
    key
  );
}

function isAbsoluteLocalPath(value: string): boolean {
  return (
    value.startsWith("/") ||
    value.startsWith("\\\\") ||
    /^[A-Za-z]:\\/.test(value) ||
    /^file:\/\/\//i.test(value)
  );
}

function isStickerTransportObject(value: Record<string, unknown>): boolean {
  return (
    value.type === "mface" ||
    Number(value.sub_type) === 1 ||
    value.emoji_package_id !== undefined ||
    value.emojiPackageId !== undefined ||
    (value.key !== undefined &&
      (value.emoji_id !== undefined ||
        value.emojiId !== undefined ||
        value.url !== undefined ||
        value.file !== undefined)) ||
    value.file === "marketface"
  );
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
