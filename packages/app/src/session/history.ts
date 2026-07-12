import path from "node:path";
import { createReadStream } from "node:fs";
import { access, readdir } from "node:fs/promises";
import type { CanonicalEvent, Conversation } from "../events/schemas";
import type { GestaltConfig } from "../home/loadConfig";
import type { GestaltHome } from "../home/resolveGestaltHome";
import { readSessionRecentHistoryHours } from "./config";
import { SESSION_JOURNAL_FILE_NAME } from "./recorder";
import {
  SessionJournalRecordSchema,
  type SessionEventRecord,
  type SessionJournalRecord
} from "./schemas";
import {
  DEFAULT_SESSION_STORE_LIMITS,
  getConversationKey,
  type AppendEventOptions,
  type SessionStore
} from "./store";

const JOURNAL_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 200;
const MAX_RECENT_MESSAGE_LIMIT = 2_048;
export const DEFAULT_MAX_PENDING_SESSION_EVENT_APPENDS = 256;

export type SessionHistoryTimestamp = string | Date;

export interface SessionHistoryTimeRange {
  since: SessionHistoryTimestamp;
  until?: SessionHistoryTimestamp;
}

export interface SessionHistoryScope {
  conversation?: Conversation;
}

export interface HistoryPage {
  items: SessionEventRecord[];
  nextCursor?: string;
}

export interface SessionHistoryReader {
  iterateRecentMessages(
    timeRange: SessionHistoryTimeRange
  ): AsyncIterable<SessionEventRecord>;
  recentMessages(
    conversation: Conversation,
    since: SessionHistoryTimestamp,
    limit: number
  ): Promise<SessionEventRecord[]>;
  findRecentMessage(
    conversation: Conversation,
    messageId: string,
    since: SessionHistoryTimestamp
  ): Promise<SessionEventRecord | undefined>;
  searchMessages(
    query: string,
    scope: SessionHistoryScope,
    timeRange: SessionHistoryTimeRange,
    cursor?: string,
    limit?: number
  ): Promise<HistoryPage>;
}

export interface HydrateRecentSessionMessagesInput {
  home: GestaltHome;
  config: GestaltConfig;
  store: Pick<SessionStore, "hydrateEvent">;
  now?: () => Date;
  reader?: SessionHistoryReader;
}

export interface HydrateRecentSessionMessagesResult {
  since: string;
  until: string;
  hydratedCount: number;
}

export interface RecentSessionEventAppender {
  appendEvent(
    event: CanonicalEvent,
    options?: AppendEventOptions
  ): Promise<SessionEventRecord>;
}

export interface CreateRecentSessionEventAppenderInput {
  config: GestaltConfig;
  store: SessionStore;
  reader: SessionHistoryReader;
  now?: () => Date;
  maxPendingAppends?: number;
}

interface JournalEntry {
  coordinate: JournalCoordinate;
  record: SessionJournalRecord;
}

interface JournalCoordinate {
  file: string;
  line: number;
}

export function createSessionHistoryReader(
  home: Pick<GestaltHome, "sessionsDir">
): SessionHistoryReader {
  const journalDirectory = path.join(home.sessionsDir, "journal");

  return {
    iterateRecentMessages(timeRange) {
      return iterateRecentMessages(journalDirectory, timeRange);
    },

    async recentMessages(conversation, since, limit) {
      assertPositiveInteger(
        limit,
        "Session history limit",
        MAX_RECENT_MESSAGE_LIMIT
      );
      const records: SessionEventRecord[] = [];
      for await (const record of iterateRecentMessages(journalDirectory, {
        since
      })) {
        if (!sameConversation(record.event.conversation, conversation)) {
          continue;
        }
        records.push(record);
        const excess = records.length - limit;
        if (excess > 0) {
          records.splice(0, excess);
        }
      }
      return records;
    },

    async findRecentMessage(conversation, messageId, since) {
      let found: SessionEventRecord | undefined;
      for await (const record of iterateRecentMessages(journalDirectory, {
        since
      })) {
        if (
          sameConversation(record.event.conversation, conversation) &&
          record.event.type === "MessageReceived" &&
          record.event.message.id === messageId
        ) {
          found = record;
        }
      }
      return found;
    },

    async searchMessages(
      query,
      scope,
      timeRange,
      cursor,
      limit = DEFAULT_PAGE_LIMIT
    ) {
      if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_PAGE_LIMIT) {
        throw new Error(
          `Session history page limit must be between 1 and ${MAX_PAGE_LIMIT}.`
        );
      }
      const normalizedQuery = query.trim().toLowerCase();
      const cursorCoordinate = cursor ? decodeCursor(cursor) : undefined;
      const candidates: Array<{
        coordinate: JournalCoordinate;
        record: SessionEventRecord;
      }> = [];

      for await (const entry of iterateJournalEntries(
        journalDirectory,
        timeRange
      )) {
        if (entry.record.type !== "event") {
          continue;
        }
        const record = entry.record.record;
        if (record.event.type !== "MessageReceived") {
          continue;
        }
        if (
          cursorCoordinate &&
          compareCoordinates(entry.coordinate, cursorCoordinate) >= 0
        ) {
          continue;
        }
        if (
          scope.conversation &&
          !sameConversation(record.event.conversation, scope.conversation)
        ) {
          continue;
        }
        if (!matchesQuery(record, normalizedQuery)) {
          continue;
        }
        candidates.push({ coordinate: entry.coordinate, record });
        const excess = candidates.length - (limit + 1);
        if (excess > 0) {
          candidates.splice(0, excess);
        }
      }

      candidates.reverse();
      const pageCandidates = candidates.slice(0, limit);
      const lastCandidate = pageCandidates.at(-1);
      return {
        items: pageCandidates.map((candidate) => candidate.record),
        ...(candidates.length > limit && lastCandidate
          ? { nextCursor: encodeCursor(lastCandidate.coordinate) }
          : {})
      };
    }
  };
}

/**
 * Restores an evicted conversation immediately before admitting its next
 * event. One bounded global admission lane preserves invocation order across
 * conversations, so a slow rehydrate can never let a later event overtake it
 * in the authoritative journal. The same lane also serializes deliveries for
 * one conversation, ensuring they share the restored prefix.
 */
export function createRecentSessionEventAppender(
  input: CreateRecentSessionEventAppenderInput
): RecentSessionEventAppender {
  const now = input.now ?? (() => new Date());
  const maxPendingAppends =
    input.maxPendingAppends ?? DEFAULT_MAX_PENDING_SESSION_EVENT_APPENDS;
  assertPositiveInteger(maxPendingAppends, "Pending session event append limit");
  let pendingAppends = 0;
  let admissionTail: Promise<void> = Promise.resolve();

  return {
    appendEvent(event, options) {
      if (pendingAppends >= maxPendingAppends) {
        return Promise.reject(
          new Error(
            `Session event admission queue is full (${maxPendingAppends} pending appends).`
          )
        );
      }
      pendingAppends += 1;
      const conversation = event.conversation;
      const operation = admissionTail.then(async () => {
        input.store.pinConversation(conversation);
        try {
          if (!input.store.hasConversation(conversation)) {
            const currentTime = now();
            const historyHours = readSessionRecentHistoryHours(input.config);
            const since = new Date(
              currentTime.valueOf() - historyHours * 60 * 60 * 1_000
            );
            const records = await input.reader.recentMessages(
              conversation,
              since,
              MAX_RECENT_MESSAGE_LIMIT
            );
            for (const record of records) {
              input.store.hydrateEvent(record);
            }
          }
          return await input.store.appendEvent(event, options);
        } finally {
          input.store.unpinConversation(conversation);
        }
      });
      admissionTail = operation.then(
        () => undefined,
        () => undefined
      );
      return operation.finally(() => {
        pendingAppends -= 1;
      });
    }
  };
}

export async function hydrateRecentSessionMessages(
  input: HydrateRecentSessionMessagesInput
): Promise<HydrateRecentSessionMessagesResult> {
  const now = input.now?.() ?? new Date();
  const historyHours = readSessionRecentHistoryHours(input.config);
  const since = new Date(now.valueOf() - historyHours * 60 * 60 * 1_000);
  const reader = input.reader ?? createSessionHistoryReader(input.home);
  const retainedConversations = new Map<string, Conversation>();
  let hydratedCount = 0;

  for await (const record of reader.iterateRecentMessages({
    since,
    until: now
  })) {
    const conversation = record.event.conversation;
    const key = getConversationKey(conversation);
    retainedConversations.delete(key);
    retainedConversations.set(key, conversation);
    if (
      retainedConversations.size >
      DEFAULT_SESSION_STORE_LIMITS.inactiveConversations
    ) {
      const oldestKey = retainedConversations.keys().next().value;
      if (oldestKey !== undefined) {
        retainedConversations.delete(oldestKey);
      }
    }
  }

  for await (const record of reader.iterateRecentMessages({
    since,
    until: now
  })) {
    if (
      retainedConversations.has(getConversationKey(record.event.conversation)) &&
      input.store.hydrateEvent(record)
    ) {
      hydratedCount += 1;
    }
  }

  return {
    since: since.toISOString(),
    until: now.toISOString(),
    hydratedCount
  };
}

async function* iterateRecentMessages(
  journalDirectory: string,
  timeRange: SessionHistoryTimeRange
): AsyncIterable<SessionEventRecord> {
  for await (const entry of iterateJournalEntries(journalDirectory, timeRange)) {
    if (
      entry.record.type === "event" &&
      entry.record.record.event.type === "MessageReceived"
    ) {
      yield entry.record.record;
    }
  }
}

async function* iterateJournalEntries(
  journalDirectory: string,
  timeRange: SessionHistoryTimeRange
): AsyncIterable<JournalEntry> {
  const since = parseTimestamp(timeRange.since, "since");
  const until = timeRange.until
    ? parseTimestamp(timeRange.until, "until")
    : undefined;
  if (until && until.valueOf() < since.valueOf()) {
    throw new Error("Session history until must not be earlier than since.");
  }

  const files = await listJournalFiles(journalDirectory, since, until);
  for (const file of files) {
    try {
      for await (const { line, lineNumber } of iterateCompleteLines(
        file.absolutePath
      )) {
        let parsedJson: unknown;
        try {
          parsedJson = JSON.parse(line);
        } catch (error) {
          throw new Error(
            `Invalid JSON in session journal ${file.relativePath}:${lineNumber}.`,
            { cause: error }
          );
        }
        const parsedRecord = SessionJournalRecordSchema.safeParse(parsedJson);
        if (!parsedRecord.success) {
          throw new Error(
            `Invalid session journal record in ${file.relativePath}:${lineNumber}: ${parsedRecord.error.message}`
          );
        }
        const recordedAt = new Date(parsedRecord.data.recordedAt);
        if (
          Number.isNaN(recordedAt.valueOf()) ||
          recordedAt.valueOf() < since.valueOf() ||
          (until && recordedAt.valueOf() > until.valueOf())
        ) {
          continue;
        }
        yield {
          coordinate: { file: file.relativePath, line: lineNumber },
          record: parsedRecord.data
        };
      }
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        continue;
      }
      throw error;
    }
  }
}

async function listJournalFiles(
  journalDirectory: string,
  since: Date,
  until: Date | undefined
): Promise<Array<{ absolutePath: string; relativePath: string }>> {
  let entries;
  try {
    entries = await readdir(journalDirectory, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const firstDay = since.toISOString().slice(0, 10);
  const lastDay = until?.toISOString().slice(0, 10);
  const candidates = entries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        JOURNAL_DAY_PATTERN.test(entry.name) &&
        entry.name >= firstDay &&
        (!lastDay || entry.name <= lastDay)
    )
    .map((entry) => {
      const relativePath = path.posix.join(
        entry.name,
        SESSION_JOURNAL_FILE_NAME
      );
      return {
        absolutePath: path.join(
          journalDirectory,
          entry.name,
          SESSION_JOURNAL_FILE_NAME
        ),
        relativePath
      };
    })
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const existingFiles = await Promise.all(
    candidates.map(async (candidate) => {
      try {
        await access(candidate.absolutePath);
        return candidate;
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
          return undefined;
        }
        throw error;
      }
    })
  );
  return existingFiles.filter(
    (candidate): candidate is { absolutePath: string; relativePath: string } =>
      candidate !== undefined
  );
}

async function* iterateCompleteLines(
  filePath: string
): AsyncIterable<{ line: string; lineNumber: number }> {
  const stream = createReadStream(filePath, { encoding: "utf8" });
  let buffered = "";
  let lineNumber = 0;
  try {
    for await (const chunk of stream) {
      buffered += chunk;
      let newlineIndex = buffered.indexOf("\n");
      while (newlineIndex >= 0) {
        lineNumber += 1;
        const completeLine = buffered.slice(0, newlineIndex);
        buffered = buffered.slice(newlineIndex + 1);
        const line = completeLine.endsWith("\r")
          ? completeLine.slice(0, -1)
          : completeLine;
        if (line.trim()) {
          yield { line, lineNumber };
        }
        newlineIndex = buffered.indexOf("\n");
      }
    }
  } finally {
    stream.destroy();
  }
  // A non-newline-terminated tail was not atomically committed and is ignored.
}

function matchesQuery(
  record: SessionEventRecord,
  normalizedQuery: string
): boolean {
  if (!normalizedQuery || record.event.type !== "MessageReceived") {
    return true;
  }
  const event = record.event;
  return [
    event.message.text,
    event.message.rawText,
    event.message.id,
    event.sender.id,
    event.sender.displayName
  ].some((value) => value?.toLowerCase().includes(normalizedQuery));
}

function sameConversation(
  left: Conversation,
  right: Conversation
): boolean {
  return left.kind === right.kind && left.id === right.id;
}

function parseTimestamp(value: SessionHistoryTimestamp, name: string): Date {
  const parsed = value instanceof Date ? new Date(value) : new Date(value);
  if (Number.isNaN(parsed.valueOf())) {
    throw new Error(`Session history ${name} must be a valid timestamp.`);
  }
  return parsed;
}

function assertPositiveInteger(
  value: number,
  name: string,
  maximum?: number
): void {
  if (
    !Number.isInteger(value) ||
    value <= 0 ||
    (maximum !== undefined && value > maximum)
  ) {
    throw new Error(
      maximum === undefined
        ? `${name} must be a positive integer.`
        : `${name} must be between 1 and ${maximum}.`
    );
  }
}

function compareCoordinates(
  left: JournalCoordinate,
  right: JournalCoordinate
): number {
  const fileComparison = left.file.localeCompare(right.file);
  return fileComparison !== 0 ? fileComparison : left.line - right.line;
}

function encodeCursor(coordinate: JournalCoordinate): string {
  return Buffer.from(JSON.stringify(coordinate), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): JournalCoordinate {
  try {
    const value = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8")
    ) as Partial<JournalCoordinate>;
    if (
      typeof value.file !== "string" ||
      !/^\d{4}-\d{2}-\d{2}\/000001\.jsonl$/.test(value.file) ||
      typeof value.line !== "number" ||
      !Number.isInteger(value.line) ||
      value.line <= 0
    ) {
      throw new Error("invalid cursor fields");
    }
    return { file: value.file, line: value.line };
  } catch (error) {
    throw new Error("Invalid session history cursor.", { cause: error });
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
