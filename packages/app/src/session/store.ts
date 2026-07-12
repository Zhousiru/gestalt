import { randomUUID } from "node:crypto";
import type { CanonicalEvent, Conversation } from "../events/schemas";
import {
  AgentLoopExitRecordSchema,
  ConversationSessionStateSchema,
  MessageWindowSchema,
  SessionEventRecordSchema,
  SessionJournalRecordSchema,
  SessionDiagnosticsSchema,
  SessionTurnRecordSchema,
  TriggerAttemptRecordSchema,
  type AgentLoopExitRecord,
  type ConversationSessionState,
  type MessageWindow,
  type MessageWindowReason,
  type SessionEventRecord,
  type SessionJournalRecord,
  type SessionDiagnostics,
  type SessionTurnRecord,
  type TriggerAttemptRecord
} from "./schemas";
import {
  sanitizeSessionMemoryValue,
  sanitizeSessionValue
} from "./sanitize";

export const DEFAULT_SESSION_STORE_LIMITS = {
  eventsPerConversation: 2_048,
  lifecycleRecordsPerConversation: 128,
  inactiveConversations: 64
} as const;

export interface SessionStoreLimits {
  eventsPerConversation: number;
  lifecycleRecordsPerConversation: number;
  inactiveConversations: number;
}

export interface AppendEventOptions {
  receivedAt?: string;
  recordId?: string;
}

export interface CreateMessageWindowInput {
  conversation: Conversation;
  eventIds: string[];
  reason?: MessageWindowReason;
  closedAt?: string;
  id?: string;
}

export interface CreatedMessageWindow {
  window: MessageWindow;
  eventRecords: SessionEventRecord[];
}

export interface CreateSessionStoreOptions {
  now?: () => Date;
  createId?: () => string;
  limits?: Partial<SessionStoreLimits>;
  initialEvents?: Iterable<unknown>;
  onJournalRecord?: (record: SessionJournalRecord) => void | Promise<void>;
  onEventAppended?: (record: SessionEventRecord) => void;
  onWindowCreated?: (window: MessageWindow) => void;
  onTriggerAttemptRecorded?: (attempt: TriggerAttemptRecord) => void;
  onTurnRecorded?: (turn: SessionTurnRecord) => void;
  onLoopExitRecorded?: (exit: AgentLoopExitRecord) => void;
}

export interface ExportSessionDiagnosticsOptions {
  exportedAt?: string;
}

/**
 * Mutations serialize journal admission; callers must await them before
 * accepting more input.
 */
export interface SessionStore {
  appendEvent(
    event: CanonicalEvent,
    options?: AppendEventOptions
  ): Promise<SessionEventRecord>;
  hydrateEvent(record: unknown): boolean;
  hasConversation(conversation: Conversation): boolean;
  createMessageWindow(
    input: CreateMessageWindowInput
  ): Promise<CreatedMessageWindow>;
  getEvents(conversation: Conversation): SessionEventRecord[];
  getEventsByIds(
    conversation: Conversation,
    eventIds: readonly string[]
  ): SessionEventRecord[];
  recordTriggerAttempt(attempt: TriggerAttemptRecord): Promise<void>;
  recordTurn(turn: SessionTurnRecord): Promise<void>;
  recordLoopExit(exit: AgentLoopExitRecord): Promise<void>;
  pinConversation(conversation: Conversation): void;
  unpinConversation(conversation: Conversation): void;
  getConversationState(
    conversation: Conversation
  ): ConversationSessionState | undefined;
  listConversationStates(): ConversationSessionState[];
  exportDiagnostics(options?: ExportSessionDiagnosticsOptions): SessionDiagnostics;
}

interface ConversationEntry {
  state: ConversationSessionState;
  lastTouched: number;
}

export function createInMemorySessionStore(
  options: CreateSessionStoreOptions = {}
): SessionStore {
  const conversations = new Map<string, ConversationEntry>();
  const conversationPinCounts = new Map<string, number>();
  const now = options.now ?? (() => new Date());
  const createId = options.createId ?? randomUUID;
  const limits = resolveLimits(options.limits);
  let touchCounter = 0;
  let mutationTail: Promise<void> = Promise.resolve();

  const store: SessionStore = {
    appendEvent(event, appendOptions = {}) {
      return enqueueMutation(async () => {
        const record = SessionEventRecordSchema.parse({
          id: appendOptions.recordId ?? createId(),
          receivedAt: appendOptions.receivedAt ?? now().toISOString(),
          event
        });
        const memoryRecord = SessionEventRecordSchema.parse(
          sanitizeSessionMemoryValue(record)
        );

        const existingConversation = conversations.get(
          getConversationKey(memoryRecord.event.conversation)
        );
        const existingRecord = existingConversation?.state.events.find(
          (candidate) => candidate.event.id === memoryRecord.event.id
        );
        if (existingConversation && existingRecord) {
          touch(existingConversation);
          return existingRecord;
        }

        await emitJournalRecord({
          type: "event",
          recordedAt: record.receivedAt,
          record
        });
        const conversation = ensureConversation(memoryRecord.event.conversation);
        appendEventRecord(conversation, memoryRecord);
        options.onEventAppended?.(memoryRecord);
        return memoryRecord;
      });
    },

    hydrateEvent(value) {
      const record = SessionEventRecordSchema.parse(
        sanitizeSessionMemoryValue(value)
      );
      const conversation = ensureConversation(record.event.conversation);
      if (
        conversation.state.events.some(
          (candidate) => candidate.event.id === record.event.id
        )
      ) {
        return false;
      }
      appendEventRecord(conversation, record);
      return true;
    },

    hasConversation(conversation) {
      return conversations.has(getConversationKey(conversation));
    },

    createMessageWindow(input) {
      return enqueueMutation(async () => {
        const conversation = ensureConversation(input.conversation);
        const records = getEventsByIds(
          conversation.state.events,
          input.eventIds
        );
        if (records.length !== input.eventIds.length) {
          const foundIds = new Set(records.map((record) => record.event.id));
          const missingIds = input.eventIds.filter((id) => !foundIds.has(id));
          throw new Error(
            `Cannot create message window for ${getConversationKey(
              input.conversation
            )}: session events are unavailable for ${missingIds.join(", ")}.`
          );
        }

        const window = MessageWindowSchema.parse({
          id: input.id ?? createId(),
          conversation: conversation.state.conversation,
          reason: input.reason ?? "manual",
          eventIds: input.eventIds,
          closedAt: input.closedAt ?? now().toISOString()
        });

        await emitJournalRecord({
          type: "message_window",
          recordedAt: window.closedAt,
          record: window
        });
        appendBounded(
          conversation.state.windows,
          window,
          limits.lifecycleRecordsPerConversation
        );
        touch(conversation);
        options.onWindowCreated?.(window);
        return { window, eventRecords: records };
      });
    },

    getEvents(conversation) {
      const entry = conversations.get(getConversationKey(conversation));
      if (!entry) {
        return [];
      }
      touch(entry);
      return entry.state.events.slice();
    },

    getEventsByIds(conversation, eventIds) {
      const entry = conversations.get(getConversationKey(conversation));
      if (!entry) {
        return [];
      }
      touch(entry);
      return getEventsByIds(entry.state.events, eventIds);
    },

    recordTriggerAttempt(attempt) {
      return enqueueMutation(async () => {
        const parsedAttempt = TriggerAttemptRecordSchema.parse(attempt);
        await emitJournalRecord({
          type: "trigger_attempt",
          recordedAt: parsedAttempt.evaluatedAt,
          record: parsedAttempt
        });
        const conversation = ensureConversation(parsedAttempt.conversation);
        appendBounded(
          conversation.state.triggerAttempts,
          parsedAttempt,
          limits.lifecycleRecordsPerConversation
        );
        touch(conversation);
        options.onTriggerAttemptRecorded?.(parsedAttempt);
      });
    },

    recordTurn(turn) {
      return enqueueMutation(async () => {
        const parsedTurn = SessionTurnRecordSchema.parse(
          sanitizeSessionValue(turn)
        );
        await emitJournalRecord({
          type: "turn",
          recordedAt: parsedTurn.endedAt,
          record: parsedTurn
        });
        const conversation = ensureConversation(parsedTurn.conversation);
        appendBounded(
          conversation.state.turns,
          parsedTurn,
          limits.lifecycleRecordsPerConversation
        );
        touch(conversation);
        options.onTurnRecorded?.(parsedTurn);
      });
    },

    recordLoopExit(exit) {
      return enqueueMutation(async () => {
        const parsedExit = AgentLoopExitRecordSchema.parse(exit);
        await emitJournalRecord({
          type: "loop_exit",
          recordedAt: parsedExit.endedAt,
          record: parsedExit
        });
        const conversation = ensureConversation(parsedExit.conversation);
        appendBounded(
          conversation.state.loopExits,
          parsedExit,
          limits.lifecycleRecordsPerConversation
        );
        touch(conversation);
        options.onLoopExitRecorded?.(parsedExit);
      });
    },

    pinConversation(conversation) {
      const key = getConversationKey(conversation);
      conversationPinCounts.set(key, (conversationPinCounts.get(key) ?? 0) + 1);
      const entry = conversations.get(key);
      if (entry) {
        touch(entry);
      }
      evictInactiveConversations();
    },

    unpinConversation(conversation) {
      const key = getConversationKey(conversation);
      const count = conversationPinCounts.get(key);
      if (count !== undefined) {
        if (count > 1) {
          conversationPinCounts.set(key, count - 1);
        } else {
          conversationPinCounts.delete(key);
        }
      }
      evictInactiveConversations();
    },

    getConversationState(conversation) {
      const entry = conversations.get(getConversationKey(conversation));
      if (!entry) {
        return undefined;
      }
      touch(entry);
      return toSafeConversationState(entry.state);
    },

    listConversationStates() {
      return Array.from(conversations.values(), ({ state }) =>
        toSafeConversationState(state)
      );
    },

    exportDiagnostics(exportOptions = {}) {
      return SessionDiagnosticsSchema.parse({
        exportedAt: exportOptions.exportedAt ?? now().toISOString(),
        conversations: Array.from(conversations.values(), ({ state }) =>
          toSafeConversationState(state)
        )
      });
    }
  };

  for (const initialEvent of options.initialEvents ?? []) {
    store.hydrateEvent(initialEvent);
  }

  return store;

  function ensureConversation(conversation: Conversation): ConversationEntry {
    const key = getConversationKey(conversation);
    const existing = conversations.get(key);
    if (existing) {
      touch(existing);
      return existing;
    }

    const created: ConversationEntry = {
      state: ConversationSessionStateSchema.parse({
        conversation,
        events: [],
        triggerAttempts: [],
        windows: [],
        turns: [],
        loopExits: []
      }),
      lastTouched: ++touchCounter
    };
    conversations.set(key, created);
    evictInactiveConversations();
    return created;
  }

  function appendEventRecord(
    conversation: ConversationEntry,
    record: SessionEventRecord
  ): void {
    appendBounded(
      conversation.state.events,
      record,
      limits.eventsPerConversation
    );
    touch(conversation);
  }

  function touch(entry: ConversationEntry): void {
    entry.lastTouched = ++touchCounter;
  }

  function evictInactiveConversations(): void {
    const inactive = Array.from(conversations.entries())
      .filter(([key]) => !conversationPinCounts.has(key))
      .sort((left, right) => left[1].lastTouched - right[1].lastTouched);
    const excess = inactive.length - limits.inactiveConversations;
    for (let index = 0; index < excess; index += 1) {
      const candidate = inactive[index];
      if (candidate) {
        conversations.delete(candidate[0]);
      }
    }
  }

  async function emitJournalRecord(
    record: SessionJournalRecord
  ): Promise<SessionJournalRecord> {
    const safeRecord = SessionJournalRecordSchema.parse(
      sanitizeSessionValue(record)
    );
    await options.onJournalRecord?.(safeRecord);
    return safeRecord;
  }

  function enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = mutationTail.then(operation);
    mutationTail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}

function toSafeConversationState(
  state: ConversationSessionState
): ConversationSessionState {
  return ConversationSessionStateSchema.parse(sanitizeSessionValue(state));
}

export function getConversationKey(conversation: Conversation): string {
  return `${conversation.kind}:${conversation.id}`;
}

function getEventsByIds(
  events: readonly SessionEventRecord[],
  eventIds: readonly string[]
): SessionEventRecord[] {
  const byEventId = new Map<string, SessionEventRecord>();
  for (const record of events) {
    if (!byEventId.has(record.event.id)) {
      byEventId.set(record.event.id, record);
    }
  }
  return eventIds.flatMap((id) => {
    const record = byEventId.get(id);
    return record ? [record] : [];
  });
}

function appendBounded<T>(values: T[], value: T, limit: number): void {
  values.push(value);
  const excess = values.length - limit;
  if (excess > 0) {
    values.splice(0, excess);
  }
}

function resolveLimits(
  input: Partial<SessionStoreLimits> | undefined
): SessionStoreLimits {
  const limits = {
    ...DEFAULT_SESSION_STORE_LIMITS,
    ...input
  };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`Session store limit ${name} must be a positive integer.`);
    }
  }
  return limits;
}
