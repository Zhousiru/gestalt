import type { CanonicalEvent } from "../events/schemas";
import type { MessageWindow, SessionEventRecord } from "../session/schemas";
import { isSelfMessageEvent } from "../events/helpers";
import type { ContextEventRecord } from "./selectContextEvents";

export interface RenderTranscriptInput {
  event: CanonicalEvent;
  window?: MessageWindow;
  windowEvents?: SessionEventRecord[];
  contextEvents?: ContextEventRecord[];
}

export function renderConversationTranscript(
  input: RenderTranscriptInput
): string {
  const contextRecords = input.contextEvents ?? [];
  const eventRecords = input.windowEvents ?? [];
  const conversation = input.window?.conversation ?? input.event.conversation;
  const conversationName = conversation.name
    ? `${conversation.name} (${conversation.kind}:${conversation.id})`
    : `${conversation.kind}:${conversation.id}`;

  const header = [
    `Conversation: ${conversationName}`,
    input.window
      ? `Window: ${input.window.reason}, seq ${input.window.fromSeq}-${input.window.toSeq}`
      : "Window: current event only"
  ];

  const body =
    contextRecords.length > 0
      ? contextRecords.map(renderContextEventRecord).join("\n\n")
      : eventRecords.length > 0
        ? eventRecords.map((record) => renderEventRecord(record)).join("\n\n")
        : renderEvent(input.event);

  return [...header, "", body].join("\n");
}

function renderContextEventRecord(record: ContextEventRecord): string {
  return renderEventRecord(record.record, record.labels);
}

function renderEventRecord(
  record: SessionEventRecord,
  contextLabels: string[] = []
): string {
  return renderEvent(record.event, record.seq, record.receivedAt, contextLabels);
}

function renderEvent(
  event: CanonicalEvent,
  seq?: number,
  receivedAt?: string,
  contextLabels: string[] = []
): string {
  if (event.type !== "MessageReceived") {
    return `[seq=${seq ?? "?"} type=${event.type}]`;
  }

  const senderName = event.sender.displayName ?? event.sender.id;
  const metadata = [
    `seq=${seq ?? "?"}`,
    `time=${event.occurredAt}`,
    receivedAt ? `received_at=${receivedAt}` : undefined,
    `sender=${senderName}`,
    `id=${event.sender.id}`,
    `message_id=${event.message.id}`,
    event.message.mentionsBot ? "mentions_bot=true" : "mentions_bot=false",
    isSelfMessageEvent(event) ? "sender_role=self" : undefined,
    contextLabels.length > 0
      ? `context=${contextLabels.join(",")}`
      : undefined,
    event.message.replyToMessageId
      ? `reply_to=${event.message.replyToMessageId}`
      : undefined
  ].filter((item): item is string => item !== undefined);

  const rawText =
    event.message.rawText && event.message.rawText !== event.message.text
      ? `\nraw: ${event.message.rawText}`
      : "";

  return [`[${metadata.join(" ")}]`, event.message.text + rawText].join("\n");
}
