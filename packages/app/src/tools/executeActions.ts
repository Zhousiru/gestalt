import type { Connector, ConnectorCallResult } from "../connectors/types";
import type { ActionProposal, ToolName } from "./schemas";

export interface ToolExecutionResult {
  proposal: ActionProposal;
  status: "executed" | "skipped" | "failed";
  result?: ConnectorCallResult;
  reason?: string;
  executedAt: string;
}

export interface ToolHandlerContext {
  connector: Connector;
  now: () => Date;
}

export interface ToolHandlerResult {
  status: ToolExecutionResult["status"];
  result?: ConnectorCallResult;
  reason?: string;
}

export type ToolImplementation = (
  proposal: ActionProposal,
  context: ToolHandlerContext
) => Promise<ToolHandlerResult>;

export type ToolImplementations = Partial<Record<ToolName, ToolImplementation>>;

export interface ExecuteActionsInput {
  connector: Connector;
  proposals: ActionProposal[];
  now?: () => Date;
  toolImplementations?: ToolImplementations;
}

export async function executeActions(
  input: ExecuteActionsInput
): Promise<ToolExecutionResult[]> {
  const now = input.now ?? (() => new Date());
  const results: ToolExecutionResult[] = [];
  const defaultImplementations = createConnectorToolImplementations();
  const implementations = {
    ...defaultImplementations,
    ...(input.toolImplementations ?? {})
  };

  for (const proposal of input.proposals) {
    const implementation = implementations[proposal.toolName];
    if (!implementation) {
      results.push({
        proposal,
        status: "failed",
        reason: `No tool implementation registered for ${proposal.toolName}.`,
        executedAt: now().toISOString()
      });
      continue;
    }

    const handlerResult = await implementation(proposal, {
      connector: input.connector,
      now
    });
    const executionResult: ToolExecutionResult = {
      proposal,
      status: handlerResult.status,
      executedAt: now().toISOString()
    };
    if (handlerResult.result !== undefined) {
      executionResult.result = handlerResult.result;
    }
    if (handlerResult.reason !== undefined) {
      executionResult.reason = handlerResult.reason;
    }
    results.push(executionResult);
  }

  return results;
}

export function createConnectorToolImplementations(): ToolImplementations {
  return {
    async say_nothing() {
      return {
        status: "skipped",
        reason: "Silence is a first-class action."
      };
    },

    async leave() {
      return {
        status: "skipped",
        reason: "Agent loop exit requested."
      };
    },

    async fetch_message(proposal, context) {
      if (proposal.toolName !== "fetch_message") {
        return {
          status: "failed",
          reason: `fetch_message handler received ${proposal.toolName}.`
        };
      }

      const result = await context.connector.fetchMessage({
        messageId: proposal.params.messageId
      });

      return {
        status: result.ok ? "executed" : "failed",
        result
      };
    },

    async read_image(proposal, context) {
      if (proposal.toolName !== "read_image") {
        return {
          status: "failed",
          reason: `read_image handler received ${proposal.toolName}.`
        };
      }

      const result = await context.connector.readImage({
        file: proposal.params.file
      });

      return {
        status: result.ok ? "executed" : "failed",
        result
      };
    },

    async send_group_message(proposal, context) {
      if (proposal.toolName !== "send_group_message") {
        return {
          status: "failed",
          reason: `send_group_message handler received ${proposal.toolName}.`
        };
      }

      const result = await context.connector.sendGroupMessage({
        groupId: proposal.params.groupId,
        text: proposal.params.text
      });

      return {
        status: result.ok ? "executed" : "failed",
        result
      };
    },

    async send_dm(proposal, context) {
      if (proposal.toolName !== "send_dm") {
        return {
          status: "failed",
          reason: `send_dm handler received ${proposal.toolName}.`
        };
      }

      const result = await context.connector.sendPrivateMessage({
        userId: proposal.params.userId,
        text: proposal.params.text
      });

      return {
        status: result.ok ? "executed" : "failed",
        result
      };
    },

    async send_image(proposal, context) {
      if (proposal.toolName !== "send_image") {
        return {
          status: "failed",
          reason: `send_image handler received ${proposal.toolName}.`
        };
      }

      const result = await context.connector.sendImage({
        conversation: proposal.params.conversation,
        file: proposal.params.file,
        ...(proposal.params.caption
          ? { caption: proposal.params.caption }
          : {}),
        ...(proposal.params.summary
          ? { summary: proposal.params.summary }
          : {}),
        ...(proposal.params.replyToMessageId
          ? { replyToMessageId: proposal.params.replyToMessageId }
          : {})
      });

      return {
        status: result.ok ? "executed" : "failed",
        result
      };
    },

    async send_sticker(proposal, context) {
      if (proposal.toolName !== "send_sticker") {
        return {
          status: "failed",
          reason: `send_sticker handler received ${proposal.toolName}.`
        };
      }

      const result = await context.connector.sendSticker({
        conversation: proposal.params.conversation,
        sticker: proposal.params.sticker,
        ...(proposal.params.replyToMessageId
          ? { replyToMessageId: proposal.params.replyToMessageId }
          : {})
      });

      return {
        status: result.ok ? "executed" : "failed",
        result
      };
    },

    async poke_user(proposal, context) {
      if (proposal.toolName !== "poke_user") {
        return {
          status: "failed",
          reason: `poke_user handler received ${proposal.toolName}.`
        };
      }

      const result = await context.connector.pokeUser({
        userId: proposal.params.userId,
        ...(proposal.params.conversation
          ? { conversation: proposal.params.conversation }
          : {})
      });

      return {
        status: result.ok ? "executed" : "failed",
        result
      };
    },

    async recall_own_message(proposal, context) {
      if (proposal.toolName !== "recall_own_message") {
        return {
          status: "failed",
          reason: `recall_own_message handler received ${proposal.toolName}.`
        };
      }

      const result = await context.connector.recallOwnMessage({
        messageId: proposal.params.messageId
      });

      return {
        status: result.ok ? "executed" : "failed",
        result
      };
    },

    async react_to_message(proposal, context) {
      if (proposal.toolName !== "react_to_message") {
        return {
          status: "failed",
          reason: `react_to_message handler received ${proposal.toolName}.`
        };
      }

      const result = await context.connector.reactToMessage({
        messageId: proposal.params.messageId,
        emojiId: proposal.params.emojiId,
        ...(proposal.params.remove !== undefined
          ? { remove: proposal.params.remove }
          : {})
      });

      return {
        status: result.ok ? "executed" : "failed",
        result
      };
    }
  };
}
