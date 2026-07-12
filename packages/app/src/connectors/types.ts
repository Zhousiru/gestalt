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

/**
 * A media reference minted by an explicit connector action. Incoming message
 * fields are deliberately not assignable to this trust boundary.
 */
export interface ConnectorMediaReference {
  source: "connector-action";
  kind: "base64" | "https-url" | "local-file";
  value: string;
}

export interface ConnectorFetchedSegment {
  segmentIndex: number;
  type: string;
  data: Record<string, unknown>;
  media?: ConnectorMediaReference;
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
  /** Media minted by an explicit connector read action. */
  media?: ConnectorMediaReference;
}

export const CONNECTOR_OUTCOME_UNKNOWN_CODE =
  "connector_action_outcome_unknown" as const;

/**
 * The connector dispatched an external action but lost the authoritative
 * response. Callers must treat this as non-retryable: the remote side may
 * already have applied the action.
 */
export class ConnectorOutcomeUnknownError extends Error {
  readonly code = CONNECTOR_OUTCOME_UNKNOWN_CODE;

  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = "ConnectorOutcomeUnknownError";
  }
}

export function isConnectorOutcomeUnknownError(
  error: unknown
): error is ConnectorOutcomeUnknownError {
  return (
    error instanceof ConnectorOutcomeUnknownError ||
    (error instanceof Error &&
      (error as Error & { code?: unknown }).code ===
        CONNECTOR_OUTCOME_UNKNOWN_CODE)
  );
}

export interface FetchMessageResult extends ConnectorCallResult {
  segments?: ConnectorFetchedSegment[];
}

export interface ReadImageResult extends ConnectorCallResult {}

export interface Connector {
  name: string;
  sendGroupMessage(input: SendGroupMessageInput): Promise<ConnectorCallResult>;
  sendPrivateMessage(
    input: SendPrivateMessageInput
  ): Promise<ConnectorCallResult>;
  sendImage(input: SendImageInput): Promise<ConnectorCallResult>;
  sendSticker(input: SendStickerInput): Promise<ConnectorCallResult>;
  fetchMessage(input: FetchMessageInput): Promise<FetchMessageResult>;
  readImage(input: ReadImageInput): Promise<ReadImageResult>;
  reactToMessage(input: ReactToMessageInput): Promise<ConnectorCallResult>;
  pokeUser(input: PokeUserInput): Promise<ConnectorCallResult>;
  recallOwnMessage(
    input: RecallOwnMessageInput
  ): Promise<ConnectorCallResult>;
}
