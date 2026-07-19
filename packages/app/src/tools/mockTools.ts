import { randomUUID } from "node:crypto";
import type {
  ToolHandlerResult,
  ToolImplementations
} from "./executeActions";
import type { ActionProposal } from "./schemas";

export interface MockToolCall {
  proposalId: string;
  toolName: ActionProposal["toolName"];
  params: unknown;
  calledAt: string;
}

export interface MockToolKit {
  implementations: ToolImplementations;
  calls: MockToolCall[];
}

export interface CreateMockToolKitOptions {
  now?: () => Date;
}

export function createMockToolKit(
  options: CreateMockToolKitOptions = {}
): MockToolKit {
  const now = options.now ?? (() => new Date());
  const calls: MockToolCall[] = [];

  function recordCall(proposal: ActionProposal): void {
    calls.push({
      proposalId: proposal.id,
      toolName: proposal.toolName,
      params: proposal.params,
      calledAt: now().toISOString()
    });
  }

  return {
    calls,
    implementations: {
      async say_nothing(proposal) {
        recordCall(proposal);
        return {
          status: "skipped",
          reason: "Mock tool recorded silence without side effects."
        } satisfies ToolHandlerResult;
      },

      async leave(proposal) {
        recordCall(proposal);
        return {
          status: "skipped",
          reason: "Mock tool recorded an agent loop exit request."
        } satisfies ToolHandlerResult;
      },

      async fetch_message(proposal) {
        recordCall(proposal);
        return {
          status: "executed",
          result: {
            ok: true,
            externalId:
              proposal.toolName === "fetch_message"
                ? proposal.params.messageId
                : `mock-tool-${randomUUID()}`,
            data:
              proposal.toolName === "fetch_message"
                ? {
                    messageId: proposal.params.messageId,
                    text: "mock fetched message"
                  }
                : {}
          }
        } satisfies ToolHandlerResult;
      },

      async read_image(proposal) {
        recordCall(proposal);
        return {
          status: "executed",
          result: {
            ok: true,
            externalId:
              proposal.toolName === "read_image"
                ? proposal.params.file
                : `mock-tool-${randomUUID()}`,
            data:
              proposal.toolName === "read_image"
                ? {
                    file: proposal.params.file,
                    summary: "mock image data"
                  }
                : {}
          }
        } satisfies ToolHandlerResult;
      },

      async send_group_message(proposal) {
        recordCall(proposal);
        return {
          status: "executed",
          result: {
            ok: true,
            externalId: `mock-tool-${randomUUID()}`
          }
        } satisfies ToolHandlerResult;
      },

      async send_dm(proposal) {
        recordCall(proposal);
        return {
          status: "executed",
          result: {
            ok: true,
            externalId: `mock-tool-${randomUUID()}`
          }
        } satisfies ToolHandlerResult;
      },

      async send_image(proposal) {
        recordCall(proposal);
        return {
          status: "executed",
          result: {
            ok: true,
            externalId: `mock-tool-${randomUUID()}`
          }
        } satisfies ToolHandlerResult;
      },

      async search_sticker(proposal) {
        recordCall(proposal);
        return {
          status: "executed",
          result: {
            ok: true,
            data: {
              stickers: [
                {
                  sticker_id: "stk_mock",
                  visual: "mock sticker"
                }
              ]
            }
          }
        } satisfies ToolHandlerResult;
      },

      async send_sticker(proposal) {
        recordCall(proposal);
        return {
          status: "executed",
          result: {
            ok: true,
            externalId: `mock-tool-${randomUUID()}`
          }
        } satisfies ToolHandlerResult;
      },

      async poke_user(proposal) {
        recordCall(proposal);
        return {
          status: "executed",
          result: {
            ok: true,
            externalId:
              proposal.toolName === "poke_user"
                ? `mock-poke-${proposal.params.userId}`
                : `mock-tool-${randomUUID()}`
          }
        } satisfies ToolHandlerResult;
      },

      async recall_own_message(proposal) {
        recordCall(proposal);
        return {
          status: "executed",
          result: {
            ok: true,
            externalId:
              proposal.toolName === "recall_own_message"
                ? proposal.params.messageId
                : `mock-tool-${randomUUID()}`
          }
        } satisfies ToolHandlerResult;
      },

      async react_to_message(proposal) {
        recordCall(proposal);
        return {
          status: "executed",
          result: {
            ok: true,
            externalId: `mock-tool-${randomUUID()}`
          }
        } satisfies ToolHandlerResult;
      }
    }
  };
}
