export function conversationKey(conversation: {
  kind?: string;
  id?: string;
}): string {
  return `${conversation.kind ?? "unknown"}:${conversation.id ?? "unknown"}`;
}

export function shortId(id: string | undefined, length = 8): string {
  if (!id) {
    return "unknown";
  }
  return id.length <= length ? id : id.slice(0, length);
}

export function durationMs(
  startedAt: string | undefined,
  endedAt: string | undefined
): number {
  const start = startedAt ? Date.parse(startedAt) : Number.NaN;
  const end = endedAt ? Date.parse(endedAt) : Number.NaN;
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return 0;
  }
  return Math.max(0, Math.round(end - start));
}

export function sortByTime<T>(
  items: T[],
  getTime: (item: T) => string | undefined
): T[] {
  return [...items].sort((a, b) => {
    const left = Date.parse(getTime(a) ?? "");
    const right = Date.parse(getTime(b) ?? "");
    return normalizeTime(left) - normalizeTime(right);
  });
}

export function truncate(value: string, maxLength = 180): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1)}...`;
}

export function jsonPreview(value: unknown, maxLength = 220): string {
  if (value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return truncate(value, maxLength);
  }
  try {
    return truncate(JSON.stringify(value), maxLength);
  } catch {
    return truncate(String(value), maxLength);
  }
}

export function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

export function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function normalizeTime(value: number): number {
  return Number.isFinite(value) ? value : 0;
}
