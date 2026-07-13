import type { CanonicalEvent, Conversation } from "../events/schemas";
import type { GestaltConfig } from "../home/loadConfig";
import type { AppendEventOptions } from "../session/store";
import type { SessionEventRecord } from "../session/schemas";
import type { ToolExecutionResult } from "../tools/executeActions";
import type { ActionProposal } from "../tools/schemas";

export interface CommitOutboundMessageInput {
  config: GestaltConfig;
  sourceEvent: CanonicalEvent;
  proposal: ActionProposal;
  result: ToolExecutionResult;
  appendEvent(
    event: CanonicalEvent,
    options?: AppendEventOptions
  ): Promise<SessionEventRecord>;
  flushDurable(): Promise<void>;
}

/**
 * Commits a known-success outbound message to its target conversation before
 * model execution may continue. The message contains no connector locator or
 * binary payload; images and stickers use a transcript-safe description.
 */
export async function commitOutboundMessage(
  input: CommitOutboundMessageInput
): Promise<SessionEventRecord | undefined> {
  if (input.result.status !== "executed") {
    return undefined;
  }
  const target = outboundMessageTarget(
    input.proposal,
    input.result,
    input.sourceEvent
  );
  if (!target) {
    return undefined;
  }

  const selfId =
    readOptionalString(input.config.flatValues, "bot_user_id") ??
    input.sourceEvent.source.accountId ??
    "gestalt-bot";
  const selfName =
    readOptionalString(input.config.flatValues, "bot_display_name") ??
    "Gestalt";
  const occurredAt = input.result.executedAt;
  const externalId = input.result.result?.externalId;
  const record = await input.appendEvent(
    {
      id: `self-event-${input.proposal.id}`,
      type: "MessageReceived",
      occurredAt,
      source: {
        platform: input.sourceEvent.source.platform,
        connector: "runtime-self",
        accountId: selfId,
        rawEventId: externalId ?? input.proposal.id
      },
      conversation: target.conversation,
      sender: {
        id: selfId,
        displayName: selfName,
        isSelf: true
      },
      message: {
        id: externalId ?? `self-message-${input.proposal.id}`,
        text: target.text,
        rawText: target.text,
        mentionsBot: false,
        ...(target.replyToMessageId
          ? { replyToMessageId: target.replyToMessageId }
          : {})
      },
      ...(target.raw ? { raw: target.raw } : {})
    },
    { receivedAt: occurredAt }
  );
  await input.flushDurable();
  return record;
}

function outboundMessageTarget(
  proposal: ActionProposal,
  result: ToolExecutionResult,
  sourceEvent: CanonicalEvent
):
  | {
      conversation: Conversation;
      text: string;
      replyToMessageId?: string;
      raw?: Record<string, unknown>;
    }
  | undefined {
  switch (proposal.toolName) {
    case "send_group_message": {
      const replyToMessageId = parseLeadingReplyMessageId(proposal.params.text);
      return {
        conversation: targetConversation(
          "group",
          proposal.params.groupId,
          sourceEvent
        ),
        text: proposal.params.text,
        ...(replyToMessageId ? { replyToMessageId } : {})
      };
    }
    case "send_dm":
      return {
        conversation: targetConversation(
          "private",
          proposal.params.userId,
          sourceEvent
        ),
        text: proposal.params.text
      };
    case "send_image":
      return {
        conversation: targetConversation(
          proposal.params.conversation.kind,
          proposal.params.conversation.id,
          sourceEvent
        ),
        text: imageTranscriptText(proposal),
        ...(proposal.params.replyToMessageId
          ? { replyToMessageId: proposal.params.replyToMessageId }
          : {})
      };
    case "send_sticker":
      return {
        conversation: targetConversation(
          proposal.params.conversation.kind,
          proposal.params.conversation.id,
          sourceEvent
        ),
        text: stickerTranscriptText(proposal, result),
        raw: {
          generatedBy: "send_sticker",
          stickerId: proposal.params.stickerId
        },
        ...(proposal.params.replyToMessageId
          ? { replyToMessageId: proposal.params.replyToMessageId }
          : {})
      };
    default:
      return undefined;
  }
}

function targetConversation(
  kind: Conversation["kind"],
  id: string,
  sourceEvent: CanonicalEvent
): Conversation {
  const same =
    sourceEvent.conversation.kind === kind && sourceEvent.conversation.id === id;
  return {
    kind,
    id,
    ...(same && sourceEvent.conversation.name
      ? { name: sourceEvent.conversation.name }
      : {})
  };
}

function imageTranscriptText(
  proposal: Extract<ActionProposal, { toolName: "send_image" }>
): string {
  const description = proposal.params.summary
    ? `[图片：${proposal.params.summary}]`
    : "[图片]";
  return proposal.params.caption
    ? `${proposal.params.caption}\n${description}`
    : description;
}

function stickerTranscriptText(
  proposal: Extract<ActionProposal, { toolName: "send_sticker" }>,
  result: ToolExecutionResult
): string {
  const data =
    result.result?.data &&
    typeof result.result.data === "object" &&
    !Array.isArray(result.result.data)
      ? (result.result.data as Record<string, unknown>)
      : undefined;
  const description = typeof data?.desc === "string" ? data.desc : undefined;
  return description
    ? `[表情包 ${proposal.params.stickerId}：${description}]`
    : `[表情包 ${proposal.params.stickerId}]`;
}

function parseLeadingReplyMessageId(text: string): string | undefined {
  return text.match(/^\[CQ:reply,id=([^\],]+)[^\]]*\]/)?.[1];
}

function readOptionalString(
  flat: GestaltConfig["flatValues"],
  key: string
): string | undefined {
  const value = flat[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`Config value ${key} must be a string.`);
  }
  return value;
}
