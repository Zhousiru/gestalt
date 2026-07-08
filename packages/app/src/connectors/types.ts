export interface SendGroupMessageInput {
  groupId: string;
  text: string;
}

export interface SendPrivateMessageInput {
  userId: string;
  text: string;
}

export interface ConversationTarget {
  kind: "group" | "private";
  id: string;
}

export interface SendImageInput {
  conversation: ConversationTarget;
  file: string;
  caption?: string;
  summary?: string;
  replyToMessageId?: string;
}

export interface SendStickerInput {
  conversation: ConversationTarget;
  sticker: string;
  replyToMessageId?: string;
}

export interface FetchMessageInput {
  messageId: string;
}

export interface ReadImageInput {
  file: string;
}

export interface ReactToMessageInput {
  messageId: string;
  emojiId: string;
  remove?: boolean;
}

export interface PokeUserInput {
  userId: string;
  conversation?: ConversationTarget;
}

export interface RecallOwnMessageInput {
  messageId: string;
}

export interface ConnectorCallResult {
  ok: boolean;
  externalId?: string;
  error?: string;
  data?: unknown;
}

export interface Connector {
  name: string;
  sendGroupMessage(input: SendGroupMessageInput): Promise<ConnectorCallResult>;
  sendPrivateMessage(
    input: SendPrivateMessageInput
  ): Promise<ConnectorCallResult>;
  sendImage(input: SendImageInput): Promise<ConnectorCallResult>;
  sendSticker(input: SendStickerInput): Promise<ConnectorCallResult>;
  fetchMessage(input: FetchMessageInput): Promise<ConnectorCallResult>;
  readImage(input: ReadImageInput): Promise<ConnectorCallResult>;
  reactToMessage(input: ReactToMessageInput): Promise<ConnectorCallResult>;
  pokeUser(input: PokeUserInput): Promise<ConnectorCallResult>;
  recallOwnMessage(
    input: RecallOwnMessageInput
  ): Promise<ConnectorCallResult>;
}
