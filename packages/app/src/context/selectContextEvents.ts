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
  const bySeq = new Map<number, ContextEventRecord>();

  for (const record of selectRecentHistory({
    events,
    beforeSeq: input.window.fromSeq,
    count: recentCount,
    includeSelfHistory: input.includeSelfHistory
  })) {
    addRecord(bySeq, record, "history");
  }

  for (const record of input.windowEvents) {
    addRecord(bySeq, record, "current_window");
  }

  const byMessageId = new Map<string, SessionEventRecord>();
  for (const record of events) {
    if (record.event.type === "MessageReceived") {
      byMessageId.set(record.event.message.id, record);
    }
  }

  for (const record of Array.from(bySeq.values()).map((entry) => entry.record)) {
    if (record.event.type !== "MessageReceived") {
      continue;
    }
    const replyToMessageId = record.event.message.replyToMessageId;
    if (!replyToMessageId) {
      continue;
    }
    const target = byMessageId.get(replyToMessageId);
    if (target) {
      addRecord(bySeq, target, "reply_target");
    }
  }

  return Array.from(bySeq.values()).sort(
    (left, right) => left.record.seq - right.record.seq
  );
}

function selectRecentHistory(input: {
  events: SessionEventRecord[];
  beforeSeq: number;
  count: number;
  includeSelfHistory: boolean;
}): SessionEventRecord[] {
  if (input.count === 0) {
    return [];
  }

  return input.events
    .filter((record) => record.seq < input.beforeSeq)
    .filter(
      (record) =>
        input.includeSelfHistory || !isSelfMessageEvent(record.event)
    )
    .slice(-input.count);
}

function addRecord(
  records: Map<number, ContextEventRecord>,
  record: SessionEventRecord,
  label: ContextEventLabel
): void {
  const existing = records.get(record.seq);
  if (existing) {
    if (!existing.labels.includes(label)) {
      existing.labels.push(label);
    }
    return;
  }
  records.set(record.seq, {
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
  return numericValue;
}
