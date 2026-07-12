import { isSelfMessageEvent } from "../events/helpers";
import type { GestaltConfig } from "../home/loadConfig";
import type { MessageWindow, SessionEventRecord } from "../session/schemas";
import type { SessionStore } from "../session/store";

export type ContextEventLabel = "history" | "current_window" | "reply_target";

export interface ContextEventRecord {
  record: SessionEventRecord;
  labels: ContextEventLabel[];
}

export interface SelectContextEventsInput {
  config: GestaltConfig;
  sessionStore: SessionStore;
  window: MessageWindow;
  windowEvents: SessionEventRecord[];
  includeSelfHistory: boolean;
  includeRecentHistory?: boolean;
}

export function selectContextEvents(
  input: SelectContextEventsInput
): ContextEventRecord[] {
  const recentCount = readNonNegativeInteger(
    input.config.flatValues,
    "context_recent_message_count",
    0
  );
  const events = input.sessionStore.getEvents(input.window.conversation);
  const byRecordId = new Map<string, ContextEventRecord>();
  const firstWindowRecord = input.windowEvents[0];

  if (input.includeRecentHistory ?? true) {
    for (const record of selectRecentHistory({
      events,
      ...(firstWindowRecord ? { beforeRecordId: firstWindowRecord.id } : {}),
      count: recentCount,
      includeSelfHistory: input.includeSelfHistory
    })) {
      addRecord(byRecordId, record, "history");
    }
  }

  for (const record of input.windowEvents) {
    addRecord(byRecordId, record, "current_window");
  }

  const byMessageId = new Map<string, SessionEventRecord>();
  for (const record of events) {
    if (record.event.type === "MessageReceived") {
      byMessageId.set(record.event.message.id, record);
    }
  }

  for (const record of Array.from(byRecordId.values()).map(
    (entry) => entry.record
  )) {
    if (record.event.type !== "MessageReceived") {
      continue;
    }
    const replyToMessageId = record.event.message.replyToMessageId;
    if (!replyToMessageId) {
      continue;
    }
    const target = byMessageId.get(replyToMessageId);
    if (target) {
      addRecord(byRecordId, target, "reply_target");
    }
  }

  const positionByRecordId = new Map(
    events.map((record, index) => [record.id, index])
  );
  return Array.from(byRecordId.values()).sort((left, right) => {
    const leftPosition = positionByRecordId.get(left.record.id);
    const rightPosition = positionByRecordId.get(right.record.id);
    return (
      (leftPosition ?? Number.MAX_SAFE_INTEGER) -
      (rightPosition ?? Number.MAX_SAFE_INTEGER)
    );
  });
}

function selectRecentHistory(input: {
  events: SessionEventRecord[];
  beforeRecordId?: string;
  count: number;
  includeSelfHistory: boolean;
}): SessionEventRecord[] {
  if (input.count === 0) {
    return [];
  }

  const beforeIndex = input.beforeRecordId
    ? input.events.findIndex((record) => record.id === input.beforeRecordId)
    : input.events.length;
  const historyEnd = beforeIndex >= 0 ? beforeIndex : input.events.length;
  return input.events
    .slice(0, historyEnd)
    .filter(
      (record) =>
        input.includeSelfHistory || !isSelfMessageEvent(record.event)
    )
    .slice(-input.count);
}

function addRecord(
  records: Map<string, ContextEventRecord>,
  record: SessionEventRecord,
  label: ContextEventLabel
): void {
  const existing = records.get(record.id);
  if (existing) {
    if (!existing.labels.includes(label)) {
      existing.labels.push(label);
    }
    return;
  }
  records.set(record.id, {
    record,
    labels: [label]
  });
}

function readNonNegativeInteger(
  flat: GestaltConfig["flatValues"],
  key: string,
  fallback: number
): number {
  const value = flat[key];
  const numericValue =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : undefined;

  if (numericValue === undefined) {
    return fallback;
  }
  if (!Number.isInteger(numericValue) || numericValue < 0) {
    throw new Error(`Config value ${key} must be a non-negative integer.`);
  }
  if (numericValue > 500) {
    throw new Error(`Config value ${key} must not exceed 500.`);
  }
  return numericValue;
}
