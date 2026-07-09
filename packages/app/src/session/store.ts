import { randomUUID } from "node:crypto";
import type { CanonicalEvent, Conversation } from "../events/schemas";
import {
  ConversationSessionSnapshotSchema,
  MessageWindowSchema,
  SessionEventRecordSchema,
  SessionSnapshotSchema,
  SessionTurnRecordSchema,
  AgentLoopExitRecordSchema,
  type AgentLoopExitRecord,
  type ConversationSessionSnapshot,
  type MessageWindow,
  type MessageWindowReason,
  type SessionEventRecord,
  type SessionSnapshot,
  type SessionTurnRecord
} from "./schemas";

export interface AppendEventOptions {
  receivedAt?: string;
}

export interface CreateMessageWindowInput {
  conversation: Conversation;
  fromSeq: number;
  toSeq: number;
  reason?: MessageWindowReason;
  closedAt?: string;
}

export interface CreatedMessageWindow {
  window: MessageWindow;
  eventRecords: SessionEventRecord[];
}

export interface ExportSessionOptions {
  exportedAt?: string;
}

export interface CreateSessionStoreOptions {
  now?: () => Date;
  onSnapshotChange?: (snapshot: SessionSnapshot) => void;
  onEventAppended?: (
    record: SessionEventRecord,
    snapshot: SessionSnapshot
  ) => void;
  onWindowCreated?: (
    window: MessageWindow,
    snapshot: SessionSnapshot
  ) => void;
  onTurnRecorded?: (
    turn: SessionTurnRecord,
    snapshot: SessionSnapshot
  ) => void;
  onLoopExitRecorded?: (
    exit: AgentLoopExitRecord,
    snapshot: SessionSnapshot
  ) => void;
}

export interface SessionStore {
  appendEvent(
    event: CanonicalEvent,
    options?: AppendEventOptions
  ): SessionEventRecord;
  createMessageWindow(input: CreateMessageWindowInput): CreatedMessageWindow;
  getEvents(
    conversation: Conversation,
    fromSeq?: number,
    toSeq?: number
  ): SessionEventRecord[];
  recordTurn(turn: SessionTurnRecord): void;
  recordLoopExit(exit: AgentLoopExitRecord): void;
  exportSnapshot(options?: ExportSessionOptions): SessionSnapshot;
  importSnapshot(snapshot: unknown): void;
}

export function createInMemorySessionStore(
  initialSnapshot?: unknown,
  options: CreateSessionStoreOptions = {}
): SessionStore {
  const conversations = new Map<string, ConversationSessionSnapshot>();
  const now = options.now ?? (() => new Date());

  if (initialSnapshot !== undefined) {
    importSnapshot(initialSnapshot, { emitChange: false });
  }

  const store: SessionStore = {
    appendEvent(event, appendOptions = {}) {
      const conversation = ensureConversation(event.conversation);
      const receivedAt = appendOptions.receivedAt ?? new Date().toISOString();
      const record = SessionEventRecordSchema.parse({
        seq: conversation.nextSeq,
        receivedAt,
        event
      });

      conversation.events.push(record);
      conversation.nextSeq += 1;
      const snapshot = exportSnapshot();
      options.onEventAppended?.(record, snapshot);
      emitSnapshot(snapshot);
      return record;
    },

    createMessageWindow(input) {
      const conversation = ensureConversation(input.conversation);
      const records = conversation.events.filter(
        (record) => record.seq >= input.fromSeq && record.seq <= input.toSeq
      );
      const firstRecord = records[0];
      const lastRecord = records.at(-1);

      if (!firstRecord || !lastRecord) {
        throw new Error(
          `Cannot create message window for ${getConversationKey(
            input.conversation
          )}: no events found between seq ${input.fromSeq} and ${input.toSeq}.`
        );
      }

      const window = MessageWindowSchema.parse({
        id: randomUUID(),
        conversation: conversation.conversation,
        reason: input.reason ?? "manual",
        fromSeq: firstRecord.seq,
        toSeq: lastRecord.seq,
        eventSeqs: records.map((record) => record.seq),
        closedAt: input.closedAt ?? new Date().toISOString()
      });

      conversation.windows.push(window);
      const snapshot = exportSnapshot();
      options.onWindowCreated?.(window, snapshot);
      emitSnapshot(snapshot);
      return {
        window,
        eventRecords: records
      };
    },

    getEvents(conversation, fromSeq, toSeq) {
      const snapshot = conversations.get(getConversationKey(conversation));
      if (!snapshot) {
        return [];
      }

      return snapshot.events.filter((record) => {
        if (fromSeq !== undefined && record.seq < fromSeq) {
          return false;
        }
        if (toSeq !== undefined && record.seq > toSeq) {
          return false;
        }
        return true;
      });
    },

    recordTurn(turn) {
      const parsedTurn = SessionTurnRecordSchema.parse(turn);
      const conversation = ensureConversation(parsedTurn.conversation);
      conversation.turns.push(parsedTurn);
      const snapshot = exportSnapshot();
      options.onTurnRecorded?.(parsedTurn, snapshot);
      emitSnapshot(snapshot);
    },

    recordLoopExit(exit) {
      const parsedExit = AgentLoopExitRecordSchema.parse(exit);
      const conversation = ensureConversation(parsedExit.conversation);
      conversation.loopExits.push(parsedExit);
      const snapshot = exportSnapshot();
      options.onLoopExitRecorded?.(parsedExit, snapshot);
      emitSnapshot(snapshot);
    },

    exportSnapshot(options = {}) {
      return exportSnapshot(options);
    },

    importSnapshot(snapshot) {
      importSnapshot(snapshot, { emitChange: true });
    }
  };

  return store;

  function ensureConversation(
    conversation: Conversation
  ): ConversationSessionSnapshot {
    const key = getConversationKey(conversation);
    const existing = conversations.get(key);
    if (existing) {
      return existing;
    }

    const created = ConversationSessionSnapshotSchema.parse({
      conversation,
      nextSeq: 1,
      events: [],
      windows: [],
      turns: [],
      loopExits: []
    });
    conversations.set(key, created);
    return created;
  }

  function exportSnapshot(options: ExportSessionOptions = {}): SessionSnapshot {
    return SessionSnapshotSchema.parse({
      version: 1,
      exportedAt: options.exportedAt ?? now().toISOString(),
      conversations: Array.from(conversations.values()).map((conversation) =>
        ConversationSessionSnapshotSchema.parse(conversation)
      )
    });
  }

  function emitSnapshot(snapshot = exportSnapshot()): void {
    options.onSnapshotChange?.(snapshot);
  }

  function importSnapshot(
    snapshot: unknown,
    options: { emitChange: boolean }
  ): void {
    const parsedSnapshot = SessionSnapshotSchema.parse(snapshot);
    conversations.clear();
    for (const conversation of parsedSnapshot.conversations) {
      const parsedConversation =
        ConversationSessionSnapshotSchema.parse(conversation);
      conversations.set(
        getConversationKey(parsedConversation.conversation),
        parsedConversation
      );
    }
    if (options.emitChange) {
      emitSnapshot();
    }
  }
}

export function getConversationKey(conversation: Conversation): string {
  return `${conversation.kind}:${conversation.id}`;
}
