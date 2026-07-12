import type { CanonicalEvent, MessageReceivedEvent } from "../events/schemas";
import { isSelfMessageEvent } from "../events/helpers";
import type { MessageWindow, SessionEventRecord } from "../session/schemas";
import type { ContextEventRecord } from "./selectContextEvents";
import {
  formatZonedDateTime,
  renderCurrentEnvironment
} from "./time";

export interface RenderTranscriptInput {
  event: CanonicalEvent;
  window?: MessageWindow;
  windowEvents?: SessionEventRecord[];
  contextEvents?: ContextEventRecord[];
  now: Date;
  timezone: string;
}

export function renderConversationTranscript(
  input: RenderTranscriptInput
): string {
  const contextRecords = input.contextEvents ?? [];
  const eventRecords =
    contextRecords.length > 0
      ? contextRecords
      : (input.windowEvents ?? []).map((record) => ({
          record,
          labels: []
        }));
  const records =
    eventRecords.length > 0
      ? eventRecords
      : [{ record: eventToRecord(input.event), labels: [] }];
  const conversation = input.window?.conversation ?? input.event.conversation;
  const replyTargets = new Map<string, SessionEventRecord>();

  for (const { record } of records) {
    if (record.event.type === "MessageReceived") {
      replyTargets.set(record.event.message.id, record);
    }
  }

  const visibleRecords = records.filter(({ record, labels }) => {
    if (record.event.type !== "MessageReceived") {
      return false;
    }
    return !(
      labels.includes("reply_target") &&
      !labels.includes("history") &&
      !labels.includes("current_window")
    );
  });

  const body: string[] = [];
  let currentDate: string | undefined;
  for (const { record } of visibleRecords) {
    const timestamp = formatChatTimestamp(
      record.event.occurredAt,
      input.timezone
    );
    if (timestamp.date !== currentDate) {
      if (body.length > 0) {
        body.push("");
      }
      body.push(timestamp.date);
      currentDate = timestamp.date;
    }
    body.push(
      "",
      renderMessage(record, timestamp.time, replyTargets, input.timezone)
    );
  }

  return [
    renderCurrentEnvironment(input.now, input.timezone),
    "",
    renderConversationHeading(conversation),
    "",
    ...body
  ].join("\n");
}

function renderConversationHeading(conversation: {
  kind: "group" | "private";
  id: string;
  name?: string | undefined;
}): string {
  if (conversation.kind === "group") {
    return conversation.name
      ? `Group chat "${conversation.name}" (group_id=${conversation.id})`
      : `Group chat (group_id=${conversation.id})`;
  }
  return conversation.name
    ? `Private chat with "${conversation.name}" (conversation_id=${conversation.id})`
    : `Private chat (conversation_id=${conversation.id})`;
}

function renderMessage(
  record: SessionEventRecord,
  time: string,
  replyTargets: ReadonlyMap<string, SessionEventRecord>,
  timezone: string
): string {
  const event = record.event;
  if (event.type !== "MessageReceived") {
    return "";
  }

  const senderName = event.sender.displayName ?? event.sender.id;
  const identity = [
    isSelfMessageEvent(event) ? "you" : undefined,
    `user_id=${event.sender.id}`,
    `message_id=${event.message.id}`,
    event.message.mentionsBot ? "mentioned you" : undefined
  ].filter((item): item is string => Boolean(item));
  const lines = [`[${time}] ${senderName} (${identity.join(", ")})`];

  if (event.message.replyToMessageId) {
    const target = replyTargets.get(event.message.replyToMessageId);
    lines.push(renderReply(event.message.replyToMessageId, target, timezone));
  }

  lines.push(messageTranscriptText(event));
  return lines.join("\n");
}

function renderReply(
  replyToMessageId: string,
  target: SessionEventRecord | undefined,
  timezone: string
): string {
  if (!target || target.event.type !== "MessageReceived") {
    return `In reply to message_id=${replyToMessageId} (the original message is not available here)`;
  }

  const event = target.event;
  const senderName = event.sender.displayName ?? event.sender.id;
  const timestamp = formatChatTimestamp(event.occurredAt, timezone);
  const selfLabel = isSelfMessageEvent(event) ? ", you" : "";
  const quote = messageTranscriptText(event)
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n");
  return [
    `In reply to [${timestamp.date} ${timestamp.time}] ${senderName} (${`user_id=${event.sender.id}`}${selfLabel}, message_id=${event.message.id}):`,
    quote
  ].join("\n");
}

function messageTranscriptText(event: MessageReceivedEvent): string {
  return event.message.rawText ?? event.message.text;
}

function formatChatTimestamp(
  value: string,
  timezone: string
): { date: string; time: string } {
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.valueOf())) {
    const zoned = formatZonedDateTime(parsed, timezone);
    return { date: zoned.date, time: zoned.time };
  }
  return { date: "Unknown date", time: "??:??" };
}

function eventToRecord(event: CanonicalEvent): SessionEventRecord {
  return {
    seq: 0,
    receivedAt: event.occurredAt,
    event
  };
}
