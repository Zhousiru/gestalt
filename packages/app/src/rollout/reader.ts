import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { createReadStream } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { parseRolloutRecord } from "./schemas";
import {
  advanceStateHash,
  computeInitialStateHash
} from "./state";
import type {
  CursorPage,
  ReconstructedInput,
  RolloutDetail,
  RolloutQuery,
  RolloutReader,
  RolloutRecord,
  RolloutRecordCounts,
  RolloutStartedRecord,
  RolloutSummary,
  UnresolvedOutboundAction
} from "./types";
import { safeFileSegment } from "./writer";

const YEAR_PATTERN = /^\d{4}$/;
const MONTH_OR_DAY_PATTERN = /^\d{2}$/;
const ROLLOUT_FILE_PATTERN = /^rollout-.+-.+\.jsonl$/;
const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 200;
const MAX_BOUNDARY_LINE_BYTES = 1024 * 1024;

export interface CreateRolloutReaderOptions {
  tracesDir: string;
}

export function createRolloutReader(
  options: CreateRolloutReaderOptions
): RolloutReader {
  return new FileRolloutReader(options.tracesDir);
}

interface RolloutFileCandidate {
  absolutePath: string;
  relativePath: string;
}

class FileRolloutReader implements RolloutReader {
  private readonly candidatesById = new Map<string, RolloutFileCandidate>();

  constructor(private readonly tracesDir: string) {}

  async list(query: RolloutQuery = {}): Promise<CursorPage<RolloutSummary>> {
    const limit = normalizeLimit(query.limit);
    const after = query.cursor ? decodeCursor(query.cursor) : undefined;
    const normalizedQuery = query.query?.trim().toLowerCase();
    const matches: Array<{
      summary: RolloutSummary;
      candidate: RolloutFileCandidate;
    }> = [];

    for await (const candidate of iterateRolloutFiles(this.tracesDir, after)) {
      const summary = await readSummary(candidate);
      this.candidatesById.set(summary.id, candidate);
      if (query.status && summary.status !== query.status) {
        continue;
      }
      if (normalizedQuery && !summaryMatches(summary, normalizedQuery)) {
        continue;
      }
      matches.push({ summary, candidate });
      if (matches.length > limit) {
        break;
      }
    }

    const page = matches.slice(0, limit);
    return {
      items: page.map((entry) => entry.summary),
      ...(matches.length > limit && page.at(-1)
        ? { nextCursor: encodeCursor(page.at(-1)!.candidate.relativePath) }
        : {})
    };
  }

  async read(id: string): Promise<RolloutDetail> {
    const candidate = await this.findById(id);
    return readRolloutCandidate(candidate);
  }

  async reconstructInput(
    id: string,
    generationId: string
  ): Promise<ReconstructedInput> {
    const detail = await this.read(id);
    let stateHash: string | undefined;
    let tools: unknown[] | undefined;
    const messages = [];

    for (const record of detail.records) {
      switch (record.type) {
        case "model_session_initialized": {
          if (stateHash) {
            throw corrupt(id, "model session initialized more than once");
          }
          const expected = computeInitialStateHash(record.messages, record.tools);
          if (record.stateHash !== expected) {
            throw corrupt(id, "initial state hash does not match its messages");
          }
          stateHash = expected;
          tools = record.tools;
          messages.push(...record.messages);
          break;
        }
        case "message_committed": {
          if (!stateHash) {
            throw corrupt(id, "message committed before model initialization");
          }
          if (record.previousStateHash !== stateHash) {
            throw corrupt(id, "message commit has a stale previous state hash");
          }
          const expected = advanceStateHash(stateHash, record.message);
          if (record.stateHash !== expected) {
            throw corrupt(id, "message commit has a non-canonical state hash");
          }
          stateHash = expected;
          messages.push(record.message);
          break;
        }
        case "generation_completed":
          if (record.generationId !== generationId) {
            break;
          }
          if (!stateHash || !tools) {
            throw corrupt(id, "generation completed before model initialization");
          }
          if (
            record.inputStateHash !== stateHash ||
            record.inputMessageCount !== messages.length
          ) {
            throw corrupt(id, "generation input does not match committed state");
          }
          return {
            rolloutId: id,
            generationId,
            stateHash,
            messageCount: messages.length,
            messages: [...messages],
            tools: [...tools]
          };
        case "rollout_started":
        case "tool_completed":
        case "outbound_action_started":
        case "outbound_action_finished":
        case "span_completed":
        case "rollout_finished":
          break;
      }
    }
    throw new Error(`Generation ${generationId} was not found in rollout ${id}.`);
  }

  private async findById(id: string): Promise<RolloutFileCandidate> {
    if (!id.trim()) {
      throw new Error("Rollout id must be non-empty.");
    }
    const cached = this.candidatesById.get(id);
    if (cached) {
      return cached;
    }
    const suffix = `-${safeFileSegment(id)}.jsonl`;
    // rolloutId and activeLoopId are the same stable id. Locating by the
    // filename suffix may enumerate date directories, but it never opens any
    // unrelated rollout file; detail reads exactly the selected JSONL.
    for await (const candidate of iterateRolloutFiles(this.tracesDir)) {
      if (candidate.relativePath.endsWith(suffix)) {
        this.candidatesById.set(id, candidate);
        return candidate;
      }
    }
    throw new Error(`Rollout ${id} was not found.`);
  }
}

async function* iterateRolloutFiles(
  tracesDir: string,
  after?: string
): AsyncIterable<RolloutFileCandidate> {
  for (const year of await readDirectoryNames(tracesDir, YEAR_PATTERN)) {
    const yearPath = path.join(tracesDir, year);
    for (const month of await readDirectoryNames(yearPath, MONTH_OR_DAY_PATTERN)) {
      const monthPath = path.join(yearPath, month);
      for (const day of await readDirectoryNames(monthPath, MONTH_OR_DAY_PATTERN)) {
        const dayPath = path.join(monthPath, day);
        const entries = await readdir(dayPath, { withFileTypes: true });
        const names = entries
          .filter(
            (entry) => entry.isFile() && ROLLOUT_FILE_PATTERN.test(entry.name)
          )
          .map((entry) => entry.name)
          .sort((left, right) => right.localeCompare(left));
        for (const name of names) {
          const relativePath = [year, month, day, name].join("/");
          if (after && relativePath.localeCompare(after) >= 0) {
            continue;
          }
          yield {
            absolutePath: path.join(dayPath, name),
            relativePath
          };
        }
      }
    }
  }
}

async function readDirectoryNames(
  directory: string,
  pattern: RegExp
): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && pattern.test(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) => right.localeCompare(left));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function readSummary(
  candidate: RolloutFileCandidate
): Promise<RolloutSummary> {
  const [first, last, info] = await Promise.all([
    readFirstRecord(candidate.absolutePath),
    readLastRecord(candidate.absolutePath),
    stat(candidate.absolutePath)
  ]);
  if (!first || first.type !== "rollout_started") {
    throw new Error(`Invalid rollout file ${candidate.relativePath}: missing start.`);
  }
  if (last?.type === "rollout_finished") {
    if (last.rolloutId !== first.rolloutId) {
      throw corrupt(first.rolloutId, "finish record belongs to another rollout");
    }
    return summaryFromBoundary(first, last, info.size);
  }
  return (await readRolloutCandidate(candidate)).summary;
}

async function readRolloutCandidate(
  candidate: RolloutFileCandidate
): Promise<RolloutDetail> {
  const [{ records, truncatedTail }, info] = await Promise.all([
    readJsonlRecords(candidate.absolutePath),
    stat(candidate.absolutePath)
  ]);
  if (records.length === 0 || records[0]?.type !== "rollout_started") {
    throw new Error(`Invalid rollout file ${candidate.relativePath}: missing start.`);
  }
  const first = records[0];
  const recordIds = new Set<string>();
  let finishedIndex = -1;
  for (const [index, record] of records.entries()) {
    if (record.rolloutId !== first.rolloutId) {
      throw corrupt(first.rolloutId, "record belongs to a different rollout");
    }
    if (recordIds.has(record.id)) {
      throw corrupt(first.rolloutId, `duplicate record id ${record.id}`);
    }
    recordIds.add(record.id);
    if (record.type === "rollout_started" && index !== 0) {
      throw corrupt(first.rolloutId, "rollout_started is not the first record");
    }
    if (record.type === "rollout_finished") {
      finishedIndex = index;
    }
  }
  if (finishedIndex >= 0 && finishedIndex !== records.length - 1) {
    throw corrupt(first.rolloutId, "records appear after rollout_finished");
  }

  const derived = deriveRecords(records);
  const finished = records.at(-1)?.type === "rollout_finished"
    ? records.at(-1)
    : undefined;
  if (finished?.type === "rollout_finished") {
    assertStoredCounts(first.rolloutId, finished.summary, derived.counts);
  }
  const summary: RolloutSummary = {
    id: first.rolloutId,
    activeLoopId: first.activeLoopId,
    startedAt: first.timestamp,
    status: finished?.type === "rollout_finished" ? finished.status : "failed",
    ...(finished?.type === "rollout_finished"
      ? { endedAt: finished.timestamp }
      : { failureReason: "process_restarted" }),
    ...(finished?.type === "rollout_finished" && finished.reason
      ? { failureReason: finished.reason }
      : {}),
    ...(first.eventId ? { eventId: first.eventId } : {}),
    ...(first.conversationKey
      ? { conversationKey: first.conversationKey }
      : {}),
    ...(first.name ? { name: first.name } : {}),
    ...derived.counts,
    byteLength: info.size
  };

  return {
    summary,
    records,
    unresolvedOutboundActions: derived.unresolvedOutboundActions,
    truncatedTail
  };
}

function deriveRecords(records: readonly RolloutRecord[]): {
  counts: RolloutRecordCounts;
  unresolvedOutboundActions: UnresolvedOutboundAction[];
} {
  const counts = emptyCounts();
  counts.recordCount = records.length;
  const outbound = new Map<
    string,
    {
      toolName: string;
      startedAt: string;
      finished: boolean;
      reason?: UnresolvedOutboundAction["reason"];
    }
  >();
  for (const record of records) {
    switch (record.type) {
      case "model_session_initialized":
        counts.messageCount += record.messages.length;
        break;
      case "message_committed":
        counts.messageCount += 1;
        break;
      case "generation_completed":
        counts.generationCount += 1;
        break;
      case "tool_completed": {
        counts.toolCount += 1;
        if (record.errorCode === "result_unknown_after_dispatch") {
          const action = outbound.get(record.toolCallId);
          if (action) {
            action.reason = "result_unknown_after_dispatch";
          }
        }
        break;
      }
      case "outbound_action_started":
        counts.outboundActionCount += 1;
        outbound.set(record.actionId, {
          toolName: record.toolName,
          startedAt: record.timestamp,
          finished: false
        });
        break;
      case "outbound_action_finished": {
        const action = outbound.get(record.actionId);
        if (action) {
          action.finished = true;
        }
        break;
      }
      case "span_completed":
        counts.spanCount += 1;
        break;
      case "rollout_started":
      case "rollout_finished":
        break;
    }
  }
  const unresolvedOutboundActions = [...outbound.entries()]
    .filter(([, action]) => !action.finished)
    .map(([actionId, action]) => ({
      actionId,
      toolName: action.toolName,
      startedAt: action.startedAt,
      status: "failed" as const,
      reason: action.reason ?? "result_unknown_after_restart"
    }));
  counts.unresolvedOutboundActionCount = unresolvedOutboundActions.length;
  return { counts, unresolvedOutboundActions };
}

function assertStoredCounts(
  rolloutId: string,
  stored: RolloutRecordCounts,
  actual: RolloutRecordCounts
): void {
  for (const key of Object.keys(actual) as Array<keyof RolloutRecordCounts>) {
    if (stored[key] !== actual[key]) {
      throw corrupt(rolloutId, `rollout summary has an invalid ${key}`);
    }
  }
}

function summaryFromBoundary(
  started: RolloutStartedRecord,
  finished: Extract<RolloutRecord, { type: "rollout_finished" }>,
  byteLength: number
): RolloutSummary {
  return {
    id: started.rolloutId,
    activeLoopId: started.activeLoopId,
    startedAt: started.timestamp,
    endedAt: finished.timestamp,
    status: finished.status,
    ...(finished.reason ? { failureReason: finished.reason } : {}),
    ...(started.eventId ? { eventId: started.eventId } : {}),
    ...(started.conversationKey
      ? { conversationKey: started.conversationKey }
      : {}),
    ...(started.name ? { name: started.name } : {}),
    ...finished.summary,
    byteLength
  };
}

async function readFirstRecord(
  filePath: string
): Promise<RolloutRecord | undefined> {
  const line = await readFirstLine(filePath);
  return line ? parseJsonlRecord(line, filePath, 1) : undefined;
}

async function readLastRecord(
  filePath: string
): Promise<RolloutRecord | undefined> {
  const line = await readLastLine(filePath);
  if (!line) {
    return undefined;
  }
  try {
    return parseJsonlRecord(line, filePath, -1);
  } catch {
    return undefined;
  }
}

async function readFirstLine(filePath: string): Promise<string | undefined> {
  const stream = createReadStream(filePath, {
    highWaterMark: 64 * 1024
  });
  const decoder = new StringDecoder("utf8");
  let value = "";
  try {
    for await (const chunk of stream) {
      value += decoder.write(chunk as Buffer);
      const newline = value.indexOf("\n");
      if (newline >= 0) {
        return value.slice(0, newline).replace(/\r$/, "").trim();
      }
      if (Buffer.byteLength(value, "utf8") > MAX_BOUNDARY_LINE_BYTES) {
        throw new Error(`Rollout boundary line exceeds ${MAX_BOUNDARY_LINE_BYTES} bytes.`);
      }
    }
    value += decoder.end();
    return value.trim() || undefined;
  } finally {
    stream.destroy();
  }
}

async function readLastLine(filePath: string): Promise<string | undefined> {
  const handle = await open(filePath, "r");
  try {
    const info = await handle.stat();
    let position = info.size;
    let suffix = Buffer.alloc(0);
    while (position > 0 && suffix.byteLength <= MAX_BOUNDARY_LINE_BYTES) {
      const length = Math.min(64 * 1024, position);
      position -= length;
      const chunk = Buffer.allocUnsafe(length);
      await handle.read(chunk, 0, length, position);
      suffix = Buffer.concat([chunk, suffix]);
      let end = suffix.length;
      while (end > 0 && (suffix[end - 1] === 10 || suffix[end - 1] === 13)) {
        end -= 1;
      }
      const previousNewline = suffix.lastIndexOf(10, end - 1);
      if (previousNewline >= 0 || position === 0) {
        const start = previousNewline >= 0 ? previousNewline + 1 : 0;
        const line = suffix.subarray(start, end).toString("utf8").trim();
        return line || undefined;
      }
    }
    return undefined;
  } finally {
    await handle.close();
  }
}

async function readJsonlRecords(filePath: string): Promise<{
  records: RolloutRecord[];
  truncatedTail: boolean;
}> {
  const records: RolloutRecord[] = [];
  const decoder = new StringDecoder("utf8");
  const stream = createReadStream(filePath, { highWaterMark: 64 * 1024 });
  let carry = "";
  let lineNumber = 0;
  for await (const chunk of stream) {
    carry += decoder.write(chunk as Buffer);
    while (true) {
      const newline = carry.indexOf("\n");
      if (newline < 0) {
        break;
      }
      const line = carry.slice(0, newline).replace(/\r$/, "").trim();
      carry = carry.slice(newline + 1);
      lineNumber += 1;
      if (line) {
        records.push(parseJsonlRecord(line, filePath, lineNumber));
      }
    }
  }
  carry += decoder.end();
  const tail = carry.trim();
  if (!tail) {
    return { records, truncatedTail: false };
  }
  try {
    records.push(parseJsonlRecord(tail, filePath, lineNumber + 1));
    return { records, truncatedTail: false };
  } catch {
    return { records, truncatedTail: true };
  }
}

function parseJsonlRecord(
  line: string,
  filePath: string,
  lineNumber: number
): RolloutRecord {
  try {
    return parseRolloutRecord(JSON.parse(line));
  } catch (error) {
    throw new Error(
      `Invalid rollout record in ${filePath}${
        lineNumber > 0 ? `:${lineNumber}` : ""
      }.`,
      { cause: error }
    );
  }
}

function encodeCursor(relativePath: string): string {
  return Buffer.from(relativePath, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): string {
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    if (!decoded || path.isAbsolute(decoded) || decoded.includes("..")) {
      throw new Error("unsafe cursor");
    }
    return decoded;
  } catch (error) {
    throw new Error("Invalid rollout cursor.", { cause: error });
  }
}

function normalizeLimit(limit?: number): number {
  if (limit === undefined) {
    return DEFAULT_PAGE_LIMIT;
  }
  if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_PAGE_LIMIT) {
    throw new Error(`Rollout page limit must be between 1 and ${MAX_PAGE_LIMIT}.`);
  }
  return limit;
}

function summaryMatches(summary: RolloutSummary, query: string): boolean {
  return [
    summary.id,
    summary.activeLoopId,
    summary.eventId,
    summary.conversationKey,
    summary.name,
    summary.status,
    summary.failureReason
  ].some((value) => value?.toLowerCase().includes(query));
}

function emptyCounts(): RolloutRecordCounts {
  return {
    recordCount: 0,
    messageCount: 0,
    generationCount: 0,
    toolCount: 0,
    outboundActionCount: 0,
    unresolvedOutboundActionCount: 0,
    spanCount: 0
  };
}

function corrupt(rolloutId: string, message: string): Error {
  return new Error(`Rollout ${rolloutId} is corrupt: ${message}.`);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
