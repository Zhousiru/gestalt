import type {
  LiveEventSink,
  RuntimeLiveEventEnvelope,
  RuntimeLiveEventType
} from "./viewTypes";
import { sanitizeUntrustedValue } from "../privacy/stickerRedaction";

export interface LiveEventBus extends LiveEventSink {
  subscribe(input: {
    lastEventId?: number;
    onEvent: (event: RuntimeLiveEventEnvelope) => void;
  }): () => void;
  getRecentEvents(): RuntimeLiveEventEnvelope[];
}

export interface CreateLiveEventBusOptions {
  maxBufferedEvents?: number;
  maxBufferedBytes?: number;
  maxEventBytes?: number;
  now?: () => Date;
}

export function createLiveEventBus(
  options: CreateLiveEventBusOptions = {}
): LiveEventBus {
  const maxBufferedEvents = options.maxBufferedEvents ?? 500;
  const maxBufferedBytes = options.maxBufferedBytes ?? 2 * 1024 * 1024;
  const maxEventBytes = options.maxEventBytes ?? 64 * 1024;
  const now = options.now ?? (() => new Date());
  const subscribers = new Set<(event: RuntimeLiveEventEnvelope) => void>();
  const recentEvents: RuntimeLiveEventEnvelope[] = [];
  const recentEventBytes: number[] = [];
  let bufferedBytes = 0;
  let nextId = 1;

  return {
    publish(type, data, at = now().toISOString()) {
      const sanitizedData = sanitizeUntrustedValue(
        summarizeEventData(type, data)
      );
      let event: RuntimeLiveEventEnvelope = {
        id: nextId,
        type: type as RuntimeLiveEventType,
        at,
        data: sanitizedData
      };
      let eventBytes = Buffer.byteLength(JSON.stringify(event), "utf8");
      if (eventBytes > maxEventBytes) {
        event = {
          ...event,
          data: oversizedEventSummary(sanitizedData, eventBytes)
        };
        eventBytes = Buffer.byteLength(JSON.stringify(event), "utf8");
        if (eventBytes > maxEventBytes) {
          event = {
            ...event,
            data: { reason: "live_event_payload_limit" }
          };
          eventBytes = Buffer.byteLength(JSON.stringify(event), "utf8");
        }
      }
      nextId += 1;
      recentEvents.push(event);
      recentEventBytes.push(eventBytes);
      bufferedBytes += eventBytes;
      while (
        recentEvents.length > maxBufferedEvents ||
        bufferedBytes > maxBufferedBytes
      ) {
        recentEvents.shift();
        bufferedBytes -= recentEventBytes.shift() ?? 0;
      }
      for (const subscriber of subscribers) {
        try {
          subscriber(event);
        } catch {
          // Live diagnostics are best-effort. A broken observer must neither
          // interrupt the chat path nor prevent healthy observers receiving
          // the same event.
          subscribers.delete(subscriber);
        }
      }
      return event as RuntimeLiveEventEnvelope<typeof data>;
    },

    subscribe(input) {
      if (input.lastEventId !== undefined) {
        for (const event of recentEvents) {
          if (event.id > input.lastEventId) {
            input.onEvent(event);
          }
        }
      }
      subscribers.add(input.onEvent);
      return () => {
        subscribers.delete(input.onEvent);
      };
    },

    getRecentEvents() {
      return [...recentEvents];
    }
  };
}

function summarizeEventData(type: string, data: unknown): Record<string, unknown> {
  const record =
    data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {};
  const inputEntity = readRecord(record.entity);
  const rolloutId =
    readString(record, "rolloutId") ??
    readString(record, "traceId") ??
    (inputEntity?.kind === "rollout" ? readString(inputEntity, "id") : undefined);
  const conversationKey =
    readString(record, "conversationKey") ??
    readConversationKey(readRecord(record.conversation)) ??
    readConversationKey(readRecord(readRecord(record.window)?.conversation));
  const signalId =
    readString(record, "signalId") ??
    readString(record, "sourceEventId") ??
    readString(record, "eventId") ??
    (inputEntity?.kind === "signal" ? readString(inputEntity, "id") : undefined);
  const entity = rolloutId
    ? { kind: "rollout" as const, id: rolloutId }
    : conversationKey
      ? { kind: "conversation" as const, id: conversationKey }
      : type.includes("sticker") || type.includes("error")
        ? { kind: "signal" as const, ...(signalId ? { id: signalId } : {}) }
        : { kind: "overview" as const };
  const status =
    readString(record, "status") ??
    readString(record, "phase") ??
    (record.error ? "failed" : undefined);
  const summary =
    readString(record, "summary") ??
    readString(record, "error") ??
    readString(record, "reason");
  const observation = readRecord(record.observation);
  return {
    entity,
    ...(rolloutId ? { rolloutId } : {}),
    ...(conversationKey ? { conversationKey } : {}),
    ...(readString(record, "eventId")
      ? { eventId: readString(record, "eventId") }
      : {}),
    ...(readString(record, "startedAt")
      ? { startedAt: readString(record, "startedAt") }
      : {}),
    ...(readString(record, "endedAt")
      ? { endedAt: readString(record, "endedAt") }
      : {}),
    ...(status ? { status } : {}),
    ...(readString(record, "phase")
      ? { phase: readString(record, "phase") }
      : {}),
    ...(summary ? { summary } : {}),
    ...(readString(observation ?? {}, "type")
      ? { observationType: readString(observation ?? {}, "type") }
      : {}),
    ...(readString(observation ?? {}, "id")
      ? { observationId: readString(observation ?? {}, "id") }
      : {}),
    ...(Array.isArray(record.eventRecords)
      ? { messageCount: record.eventRecords.length }
      : {}),
    ...(Array.isArray(record.proposedActions)
      ? { actionCount: record.proposedActions.length }
      : {}),
    ...(Array.isArray(record.toolResults)
      ? { toolCount: record.toolResults.length }
      : {})
  };
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readConversationKey(
  conversation: Record<string, unknown> | undefined
): string | undefined {
  const kind = conversation ? readString(conversation, "kind") : undefined;
  const id = conversation ? readString(conversation, "id") : undefined;
  return (kind === "group" || kind === "private") && id
    ? `${kind}:${id}`
    : undefined;
}

function readString(
  record: Record<string, unknown>,
  key: string
): string | undefined {
  const value = record[key];
  return typeof value === "string" && value ? value : undefined;
}

function oversizedEventSummary(
  data: unknown,
  originalByteLength: number
): Record<string, unknown> {
  const record =
    data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : undefined;
  const entity = readRecord(record?.entity);
  return {
    truncated: true,
    originalByteLength,
    reason: "live_event_payload_limit",
    ...(entity ? { entity } : {}),
    ...(typeof record?.rolloutId === "string"
      ? { rolloutId: record.rolloutId }
      : {}),
    ...(typeof record?.conversationKey === "string"
      ? { conversationKey: record.conversationKey }
      : {}),
    status: "rejected",
    summary: "Live event payload exceeded the per-event byte budget."
  };
}
