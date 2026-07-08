import { randomUUID } from "node:crypto";
import type { MessageReceivedEvent } from "../../events/schemas";
import type {
  Connector,
  ConnectorCallResult,
  FetchMessageInput,
  PokeUserInput,
  ReactToMessageInput,
  ReadImageInput,
  RecallOwnMessageInput,
  SendGroupMessageInput,
  SendImageInput,
  SendPrivateMessageInput,
  SendStickerInput
} from "../types";

export interface MockMessageEventInput {
  conversationKind?: "group" | "private";
  conversationId?: string;
  conversationName?: string;
  senderId?: string;
  senderName?: string;
  messageId?: string;
  text?: string;
  rawText?: string;
  mentionsBot?: boolean;
  replyToMessageId?: string;
  occurredAt?: string;
}

export interface MockSentGroupMessage {
  externalId: string;
  input: SendGroupMessageInput;
  sentAt: string;
}

export interface MockConnectorCall {
  kind:
    | "send_group_message"
    | "send_private_message"
    | "send_image"
    | "send_sticker"
    | "fetch_message"
    | "read_image"
    | "react_to_message"
    | "poke_user"
    | "recall_own_message";
  externalId: string;
  input: unknown;
  calledAt: string;
}

export interface MockConnector extends Connector {
  sentGroupMessages: MockSentGroupMessage[];
  calls: MockConnectorCall[];
  createMessageEvent(input?: MockMessageEventInput): MessageReceivedEvent;
}

export interface CreateMockConnectorOptions {
  now?: () => Date;
}

export function createMockConnector(
  options: CreateMockConnectorOptions = {}
): MockConnector {
  const now = options.now ?? (() => new Date());
  const sentGroupMessages: MockSentGroupMessage[] = [];
  const calls: MockConnectorCall[] = [];

  function recordCall(
    kind: MockConnectorCall["kind"],
    input: unknown
  ): ConnectorCallResult {
    const externalId = `mock-message-${randomUUID()}`;
    calls.push({
      kind,
      externalId,
      input,
      calledAt: now().toISOString()
    });
    return {
      ok: true,
      externalId
    };
  }

  return {
    name: "mock",
    sentGroupMessages,
    calls,

    createMessageEvent(input = {}) {
      return createMockMessageEvent({
        ...input,
        occurredAt: input.occurredAt ?? now().toISOString()
      });
    },

    async sendGroupMessage(input: SendGroupMessageInput): Promise<ConnectorCallResult> {
      const result = recordCall("send_group_message", input);
      sentGroupMessages.push({
        externalId: result.externalId ?? "mock-message",
        input,
        sentAt: now().toISOString()
      });
      return result;
    },

    async sendPrivateMessage(
      input: SendPrivateMessageInput
    ): Promise<ConnectorCallResult> {
      return recordCall("send_private_message", input);
    },

    async sendImage(input: SendImageInput): Promise<ConnectorCallResult> {
      return recordCall("send_image", input);
    },

    async sendSticker(input: SendStickerInput): Promise<ConnectorCallResult> {
      return recordCall("send_sticker", input);
    },

    async fetchMessage(
      input: FetchMessageInput
    ): Promise<ConnectorCallResult> {
      const result = recordCall("fetch_message", input);
      return {
        ...result,
        externalId: input.messageId,
        data: {
          messageId: input.messageId,
          text: "mock fetched message",
          raw: {
            mock: true
          }
        }
      };
    },

    async readImage(input: ReadImageInput): Promise<ConnectorCallResult> {
      const result = recordCall("read_image", input);
      return {
        ...result,
        externalId: input.file,
        data: {
          file: input.file,
          summary: "mock image data"
        }
      };
    },

    async reactToMessage(
      input: ReactToMessageInput
    ): Promise<ConnectorCallResult> {
      return recordCall("react_to_message", input);
    },

    async pokeUser(input: PokeUserInput): Promise<ConnectorCallResult> {
      return recordCall("poke_user", input);
    },

    async recallOwnMessage(
      input: RecallOwnMessageInput
    ): Promise<ConnectorCallResult> {
      return recordCall("recall_own_message", input);
    }
  };
}

export function createMockMessageEvent(
  input: MockMessageEventInput = {}
): MessageReceivedEvent {
  const conversationKind = input.conversationKind ?? "group";
  const conversationId = input.conversationId ?? "mock-group";
  const text = input.text ?? "gestalt 在吗？";

  return {
    id: `event-${randomUUID()}`,
    type: "MessageReceived",
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    source: {
      platform: "mock",
      connector: "mock"
    },
    conversation: {
      kind: conversationKind,
      id: conversationId,
      ...(input.conversationName ? { name: input.conversationName } : {})
    },
    sender: {
      id: input.senderId ?? "mock-user",
      ...(input.senderName ? { displayName: input.senderName } : {})
    },
    message: {
      id: input.messageId ?? `message-${randomUUID()}`,
      text,
      rawText: input.rawText ?? text,
      mentionsBot: input.mentionsBot ?? true,
      ...(input.replyToMessageId
        ? { replyToMessageId: input.replyToMessageId }
        : {})
    },
    raw: {
      mock: true
    }
  };
}
