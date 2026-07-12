import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { MessageReceivedEvent } from "../../events/schemas";
import type {
  Connector,
  ConnectorCallResult,
  ConnectorFetchedSegment,
  ConnectorMediaReference,
  ConversationTarget,
  FetchMessageInput,
  FetchMessageResult,
  PokeUserInput,
  ReactToMessageInput,
  ReadImageInput,
  ReadImageResult,
  RecallOwnMessageInput,
  SendGroupMessageInput,
  SendImageInput,
  SendPrivateMessageInput,
  SendStickerInput
} from "../types";
import {
  createOneBotSendMessage,
  escapeCqText,
  findOneBotReplyMessageId,
  hasOneBotMentionTarget,
  normalizeOneBotMessageSegments,
  renderCqCode,
  renderOneBotMessageMarkup
} from "./message";
import {
  OneBotMessageEventSchema,
  OneBotMessageSchema,
  type OneBotMessageEvent
} from "./schemas";

export interface OneBotActionCaller {
  callAction(
    action: string,
    params?: Record<string, unknown>
  ): Promise<ConnectorCallResult & { data?: unknown }>;
}

export interface OneBotConnector extends Connector {
  normalizeEvent(rawEvent: unknown): MessageReceivedEvent | undefined;
}

export interface CreateOneBotConnectorOptions {
  caller: OneBotActionCaller;
  platform?: string;
}

export function createOneBotConnector(
  options: CreateOneBotConnectorOptions
): OneBotConnector {
  return {
    name: "onebot-v11",

    normalizeEvent(rawEvent) {
      const parsed = OneBotMessageEventSchema.safeParse(rawEvent);
      if (!parsed.success) {
        return undefined;
      }
      return normalizeOneBotMessageEvent(parsed.data, {
        platform: options.platform ?? "qq"
      });
    },

    async sendGroupMessage(
      input: SendGroupMessageInput
    ): Promise<ConnectorCallResult> {
      const result = await options.caller.callAction("send_group_msg", {
        group_id: Number(input.groupId),
        message: createOneBotSendMessage(input),
        auto_escape: false
      });
      if (!result.ok) {
        return result;
      }
      const externalId = extractMessageId(result.data) ?? result.externalId;
      return {
        ok: true,
        ...(externalId ? { externalId } : {})
      };
    },

    async sendPrivateMessage(
      input: SendPrivateMessageInput
    ): Promise<ConnectorCallResult> {
      const result = await options.caller.callAction("send_private_msg", {
        user_id: Number(input.userId),
        message: createOneBotSendMessage(input),
        auto_escape: false
      });
      return normalizeSendResult(result);
    },

    async sendImage(input: SendImageInput): Promise<ConnectorCallResult> {
      const result = await sendConversationMessage(options.caller, {
        conversation: input.conversation,
        text: buildImageMessage(input)
      });
      return normalizeSendResult(result);
    },

    async sendSticker(input: SendStickerInput): Promise<ConnectorCallResult> {
      const result = await sendConversationMessage(options.caller, {
        conversation: input.conversation,
        text: buildStickerMessage(input)
      });
      return normalizeSendResult(result);
    },

    async fetchMessage(input: FetchMessageInput): Promise<FetchMessageResult> {
      const result = await options.caller.callAction("get_msg", {
        message_id: Number(input.messageId)
      });
      if (!result.ok) {
        return result;
      }
      const segments = normalizeFetchedMediaSegments(result.data);
      return {
        ok: true,
        externalId: input.messageId,
        data: normalizeFetchedMessageData(
          result.data,
          input.messageId
        ),
        ...(segments ? { segments } : {})
      };
    },

    async readImage(input: ReadImageInput): Promise<ReadImageResult> {
      const result = await options.caller.callAction("get_image", {
        file: input.file
      });
      if (!result.ok) {
        return result;
      }
      const media = normalizeReadImageMedia(result.data, input.file);
      return {
        ok: true,
        externalId: input.file,
        data: normalizeImageData(result.data, input.file),
        ...(media ? { media } : {})
      };
    },

    async reactToMessage(
      input: ReactToMessageInput
    ): Promise<ConnectorCallResult> {
      const result = await options.caller.callAction("set_msg_emoji_like", {
        message_id: Number(input.messageId),
        emoji_id: input.emojiId,
        set: input.remove ? false : true
      });
      return result.ok
        ? {
            ok: true,
            ...(result.externalId ? { externalId: result.externalId } : {})
          }
        : result;
    },

    async pokeUser(input: PokeUserInput): Promise<ConnectorCallResult> {
      const result = await options.caller.callAction("send_poke", {
        ...(input.conversation?.kind === "group"
          ? { group_id: Number(input.conversation.id) }
          : {}),
        user_id: Number(input.userId)
      });
      return result.ok
        ? {
            ok: true,
            ...(result.externalId ? { externalId: result.externalId } : {})
          }
        : result;
    },

    async recallOwnMessage(
      input: RecallOwnMessageInput
    ): Promise<ConnectorCallResult> {
      const result = await options.caller.callAction("delete_msg", {
        message_id: Number(input.messageId)
      });
      return result.ok
        ? {
            ok: true,
            externalId: input.messageId
          }
        : result;
    }
  };
}

export function normalizeOneBotMessageEvent(
  event: OneBotMessageEvent,
  options: { platform?: string } = {}
): MessageReceivedEvent {
  const onebotSegments = normalizeOneBotMessageSegments(event.message);
  const accountId = String(event.self_id);
  const messageId = String(event.message_id);
  const senderName =
    event.message_type === "group"
      ? event.sender?.card || event.sender?.nickname
      : event.sender?.nickname;
  const text = renderOneBotMessageMarkup(onebotSegments) || event.raw_message;
  const replyToMessageId = findOneBotReplyMessageId(onebotSegments);

  return {
    id: `onebot-${event.self_id}-${event.message_type}-${messageId}`,
    type: "MessageReceived",
    occurredAt: new Date(event.time * 1000).toISOString(),
    source: {
      platform: options.platform ?? "qq",
      connector: "onebot-v11",
      accountId,
      rawEventId: messageId
    },
    conversation:
      event.message_type === "group"
        ? {
            kind: "group",
            id: String(event.group_id)
          }
        : {
            kind: "private",
            id: String(event.user_id)
          },
    sender: {
      id: String(event.user_id),
      ...(senderName ? { displayName: senderName } : {}),
      ...(String(event.user_id) === accountId ? { isSelf: true } : {})
    },
    message: {
      id: messageId,
      text,
      rawText: event.raw_message,
      mentionsBot: hasOneBotMentionTarget(onebotSegments, accountId),
      sourceContent: {
        format: "onebot-v11",
        segments: onebotSegments
      },
      ...(replyToMessageId ? { replyToMessageId } : {})
    },
    raw: event
  };
}

export function createOneBotMockActionCaller(
  onCall?: (call: {
    action: string;
    params?: Record<string, unknown>;
    echo: string;
  }) => void
): OneBotActionCaller {
  return {
    async callAction(action, params) {
      const echo = randomUUID();
      onCall?.({
        action,
        echo,
        ...(params ? { params } : {})
      });
      return {
        ok: true,
        externalId: `onebot-mock-${randomUUID()}`,
        data:
          action === "send_group_msg" ||
          action === "send_private_msg" ||
          action === "send_msg"
            ? {
                message_id: Math.floor(Math.random() * 1_000_000)
              }
            : action === "get_msg"
              ? {
                  time: Math.floor(Date.now() / 1000),
                  message_type: "group",
                  message_id:
                    typeof params?.message_id === "number"
                      ? params.message_id
                      : 111,
                  real_id:
                    typeof params?.message_id === "number"
                      ? params.message_id
                      : 111,
                  sender: {
                    user_id: 424242,
                    nickname: "Fetched User",
                    card: "Fetched User"
                  },
                  message: [
                    {
                      type: "text",
                      data: {
                        text: "被引用的 mock 消息"
                      }
                    }
                  ]
                }
              : action === "get_image"
                ? {
                    file: `/mock/onebot/image/${String(params?.file ?? "image")}`
                  }
            : {}
      };
    }
  };
}

async function sendConversationMessage(
  caller: OneBotActionCaller,
  input: {
    conversation: ConversationTarget;
    text: string;
  }
): Promise<ConnectorCallResult & { data?: unknown }> {
  const base = {
    message_type: input.conversation.kind,
    message: createOneBotSendMessage({ text: input.text }),
    auto_escape: false
  };
  if (input.conversation.kind === "group") {
    return caller.callAction("send_msg", {
      ...base,
      group_id: Number(input.conversation.id)
    });
  }
  return caller.callAction("send_msg", {
    ...base,
    user_id: Number(input.conversation.id)
  });
}

function buildImageMessage(input: SendImageInput): string {
  return compactMessageParts([
    input.replyToMessageId
      ? renderCqCode("reply", { id: input.replyToMessageId })
      : undefined,
    input.caption ? escapeCqText(input.caption) : undefined,
    renderCqCode("image", {
      file: input.file,
      ...(input.summary ? { summary: input.summary } : {})
    })
  ]);
}

function buildStickerMessage(input: SendStickerInput): string {
  return compactMessageParts([
    input.replyToMessageId
      ? renderCqCode("reply", { id: input.replyToMessageId })
      : undefined,
    input.sticker
  ]);
}

function compactMessageParts(parts: Array<string | undefined>): string {
  return parts.filter((part): part is string => Boolean(part)).join("");
}

function normalizeSendResult(
  result: ConnectorCallResult & { data?: unknown }
): ConnectorCallResult {
  if (!result.ok) {
    return result;
  }
  const externalId = extractMessageId(result.data) ?? result.externalId;
  return {
    ok: true,
    ...(externalId ? { externalId } : {})
  };
}

function extractMessageId(data: unknown): string | undefined {
  if (!data || typeof data !== "object") {
    return undefined;
  }
  const messageId = (data as { message_id?: unknown }).message_id;
  return messageId === undefined ? undefined : String(messageId);
}

function normalizeFetchedMessageData(
  data: unknown,
  fallbackMessageId: string
): Record<string, unknown> {
  const messageId = extractMessageId(data) ?? fallbackMessageId;
  const raw = readRecord(data);
  const rawMessage = raw ? readOptionalString(raw.raw_message) : undefined;
  const message = raw ? raw.message : undefined;
  const renderedText =
    message !== undefined
      ? renderOneBotMessageMarkup(
          normalizeOneBotMessageSegments(OneBotMessageSchema.parse(message))
        )
      : rawMessage;
  const text = renderedText;
  const sender = readRecord(raw?.sender);
  const senderId = readOptionalString(sender?.user_id);
  const senderName =
    readOptionalString(sender?.card) ?? readOptionalString(sender?.nickname);

  return {
    messageId,
    ...(readOptionalString(raw?.message_type)
      ? { messageType: readOptionalString(raw?.message_type) }
      : {}),
    ...(typeof raw?.time === "number"
      ? { occurredAt: new Date(raw.time * 1000).toISOString() }
      : {}),
    ...(senderId || senderName
      ? {
          sender: {
            ...(senderId ? { id: senderId } : {}),
            ...(senderName ? { displayName: senderName } : {})
          }
        }
      : {}),
    ...(text ? { text } : {}),
    ...(rawMessage && rawMessage !== text
      ? { rawText: rawMessage }
      : {})
  };
}

function normalizeImageData(
  data: unknown,
  fallbackFile: string
): Record<string, unknown> {
  const raw = readRecord(data);
  const file = readOptionalString(raw?.file) ?? fallbackFile;
  return {
    file,
    ...(readOptionalString(raw?.url) ? { url: readOptionalString(raw?.url) } : {}),
    raw: data
  };
}

function normalizeFetchedMediaSegments(
  data: unknown
): ConnectorFetchedSegment[] | undefined {
  const raw = readRecord(data);
  if (raw?.message === undefined) {
    return undefined;
  }
  const parsed = OneBotMessageSchema.safeParse(raw.message);
  if (!parsed.success) {
    return undefined;
  }
  return normalizeOneBotMessageSegments(parsed.data).map((segment, segmentIndex) => {
    const media = isImageLikeSegment(segment.type)
      ? normalizeActionMediaFromData(segment.data, { allowLocalFile: false })
      : undefined;
    return {
      segmentIndex,
      type: segment.type,
      data: segment.data,
      ...(media ? { media } : {})
    };
  });
}

function normalizeReadImageMedia(
  data: unknown,
  fallbackFile: string
): ConnectorMediaReference | undefined {
  const raw = readRecord(data);
  if (!raw) {
    return undefined;
  }
  return normalizeActionMediaFromData(raw, {
    allowLocalFile: true,
    fallbackOpaqueToken: fallbackFile
  });
}

function normalizeActionMediaFromData(
  data: Record<string, unknown>,
  options: { allowLocalFile: boolean; fallbackOpaqueToken?: string }
): ConnectorMediaReference | undefined {
  for (const candidate of [data.base64, data.url, data.file]) {
    const value = readOptionalString(candidate);
    if (!value) {
      continue;
    }
    if (isBase64Reference(value)) {
      return { source: "connector-action", kind: "base64", value };
    }
    if (isHttpsReference(value)) {
      return { source: "connector-action", kind: "https-url", value };
    }
  }

  if (!options.allowLocalFile) {
    return undefined;
  }
  const file = readOptionalString(data.file);
  if (
    !file ||
    file === options.fallbackOpaqueToken ||
    !isAbsoluteLocalReference(file)
  ) {
    return undefined;
  }
  return { source: "connector-action", kind: "local-file", value: file };
}

function isImageLikeSegment(type: string): boolean {
  return type === "image" || type === "mface";
}

function isBase64Reference(value: string): boolean {
  return value.startsWith("base64://") || /^data:image\/[a-z0-9.+-]+;base64,/i.test(value);
}

function isHttpsReference(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function isAbsoluteLocalReference(value: string): boolean {
  if (value.startsWith("file://")) {
    try {
      return path.isAbsolute(fileURLToPath(value));
    } catch {
      return false;
    }
  }
  return path.isAbsolute(value);
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  return String(value);
}

function readOptionalString(value: unknown): string | undefined {
  const text = readString(value);
  return text ? text : undefined;
}
