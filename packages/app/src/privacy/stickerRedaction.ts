import type { MessageReceivedEvent } from "../events/schemas";

export function visibleMessageText(
  event: MessageReceivedEvent,
  options: { preferRaw?: boolean } = {}
): string {
  return options.preferRaw
    ? (event.message.rawText ?? event.message.text)
    : event.message.text;
}

/** Redacts generic secrets while leaving complete CQ markup inspectable. */
export function redactSensitiveString(
  value: string,
  options: { redactUrls?: boolean } = {}
): string {
  const cq: string[] = [];
  const protectedValue = value.replace(
    /\[CQ:[A-Za-z0-9_-]+(?:,[^\]]*)?\]/g,
    (markup) => {
      const index = cq.push(markup) - 1;
      return `\uE000CQ${index}\uE001`;
    }
  );
  let redacted = protectedValue
    .replace(/base64:\/\/[A-Za-z0-9+/=\s]+/gi, "[表情数据]")
    .replace(
      /data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+/gi,
      "[表情数据]"
    )
    .replace(/file:\/\/\/[^\s"'<>\]]+/gi, "[PATH]")
    .replace(/(["'])(?:[A-Za-z]:\\|\\\\)[^"'\r\n]+\1/g, "[PATH]")
    .replace(
      /(["'])\/(?:home|Users|tmp|var|opt|root|mnt)\/[^"'\r\n]+\1/g,
      "[PATH]"
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

/**
 * Converts internal/runtime values into a diagnostic-output-safe JSON value.
 * Canonical replay, model-readable CQ, and Live CQ text remain untouched. This
 * still removes binary payloads, structured transport data, paths, and API keys.
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
    if (
      key === "raw" ||
      key === "sourceContent" ||
      key === "segment" ||
      key === "segments" ||
      key === "media" ||
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
      redactUrls || stickerTransportObject || isDiagnosticStringKey(key),
      stickerTransportObject
    );
  }
  seen.delete(value);
  return output;
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
