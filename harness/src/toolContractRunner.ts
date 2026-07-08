import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createMockConnector,
  createMockToolKit,
  createOneBotConnector,
  createOneBotMockActionCaller,
  executeActions,
  type ActionProposal,
  type MockToolCall,
  type OneBotActionCaller,
  type ToolExecutionResult
} from "@gestalt/app";

export interface ToolContractRunResult {
  id: string;
  proposals: ActionProposal[];
  mockToolCalls: MockToolCall[];
  mockToolResults: ToolExecutionResult[];
  connectorResults: ToolExecutionResult[];
  onebotApiCalls: OneBotApiCall[];
  artifactPaths: {
    proposals: string;
    mockToolCalls: string;
    mockToolResults: string;
    connectorResults: string;
    onebotApiCalls: string;
    report: string;
  };
}

export interface OneBotApiCall {
  action: string;
  params?: Record<string, unknown>;
  echo?: string;
}

const RUN_ID = "tool-contract-e2e";
const FIXED_TIME = "2026-01-01T00:00:00.000Z";

export async function runToolContractE2E(): Promise<ToolContractRunResult> {
  const repoRoot = path.resolve(import.meta.dirname, "..", "..");
  const artifactDir = path.join(repoRoot, "harness", "artifacts", RUN_ID);
  const proposals = createToolContractProposals();

  const mockConnector = createMockConnector({
    now: () => new Date(FIXED_TIME)
  });
  const mockTools = createMockToolKit({
    now: () => new Date(FIXED_TIME)
  });
  const mockToolResults = await executeActions({
    connector: mockConnector,
    proposals,
    now: () => new Date(FIXED_TIME),
    toolImplementations: mockTools.implementations
  });

  const onebotApiCalls: OneBotApiCall[] = [];
  const onebotConnector = createOneBotConnector({
    caller: createRecordingOneBotCaller(onebotApiCalls)
  });
  const connectorResults = await executeActions({
    connector: onebotConnector,
    proposals,
    now: () => new Date(FIXED_TIME)
  });

  const artifactPaths = await writeArtifacts({
    artifactDir,
    proposals,
    mockToolCalls: mockTools.calls,
    mockToolResults,
    connectorResults,
    onebotApiCalls
  });

  return {
    id: RUN_ID,
    proposals,
    mockToolCalls: mockTools.calls,
    mockToolResults,
    connectorResults,
    onebotApiCalls,
    artifactPaths
  };
}

function createToolContractProposals(): ActionProposal[] {
  const proposedAt = FIXED_TIME;
  return [
    {
      id: randomUUID(),
      proposedAt,
      toolName: "say_nothing",
      reason: "No visible action needed.",
      params: {}
    },
    {
      id: randomUUID(),
      proposedAt,
      toolName: "fetch_message",
      reason: "The quoted message is outside the visible transcript.",
      params: {
        messageId: "111"
      }
    },
    {
      id: randomUUID(),
      proposedAt,
      toolName: "read_image",
      reason: "The model needs platform image metadata before commenting.",
      params: {
        file: "cat.png"
      }
    },
    {
      id: randomUUID(),
      proposedAt,
      toolName: "send_group_message",
      reason: "Reply publicly in the group.",
      params: {
        groupId: "123456",
        text: "[CQ:reply,id=321]群里收到 [CQ:face,id=14,name=微笑]"
      }
    },
    {
      id: randomUUID(),
      proposedAt,
      toolName: "send_dm",
      reason: "Private follow-up was explicitly invited.",
      params: {
        userId: "424242",
        text: "私聊收到 [CQ:face,id=14,name=微笑]"
      }
    },
    {
      id: randomUUID(),
      proposedAt,
      toolName: "send_image",
      reason: "Send the image that was explicitly provided.",
      params: {
        conversation: {
          kind: "group",
          id: "123456"
        },
        file: "https://example.test/cat.png",
        caption: "图片来了",
        summary: "示例图片",
        replyToMessageId: "321"
      }
    },
    {
      id: randomUUID(),
      proposedAt,
      toolName: "send_sticker",
      reason: "Repeat the exact received platform sticker.",
      params: {
        conversation: {
          kind: "group",
          id: "123456"
        },
        sticker:
          "[CQ:mface,emoji_package_id=232743,emoji_id=e236bd3faf64e579678ec218df99fdba,key=c643d011575a7054,summary=&#91;敲黑板&#93;]",
        replyToMessageId: "321"
      }
    },
    {
      id: randomUUID(),
      proposedAt,
      toolName: "react_to_message",
      reason: "A lightweight acknowledgement is enough.",
      params: {
        messageId: "321",
        emojiId: "14"
      }
    },
    {
      id: randomUUID(),
      proposedAt,
      toolName: "poke_user",
      reason: "A light QQ poke was explicitly invited.",
      params: {
        userId: "424242",
        conversation: {
          kind: "group",
          id: "123456"
        }
      }
    },
    {
      id: randomUUID(),
      proposedAt,
      toolName: "recall_own_message",
      reason: "Recall a recently sent bot message.",
      params: {
        messageId: "987654"
      }
    },
    {
      id: randomUUID(),
      proposedAt,
      toolName: "leave",
      reason: "The active loop can return to trigger handling.",
      params: {}
    }
  ];
}

function createRecordingOneBotCaller(
  calls: OneBotApiCall[]
): OneBotActionCaller {
  const caller = createOneBotMockActionCaller((call) => {
    calls.push({
      action: call.action,
      ...(call.params ? { params: call.params } : {}),
      echo: call.echo
    });
  });
  return caller;
}

async function writeArtifacts(input: {
  artifactDir: string;
  proposals: ActionProposal[];
  mockToolCalls: MockToolCall[];
  mockToolResults: ToolExecutionResult[];
  connectorResults: ToolExecutionResult[];
  onebotApiCalls: OneBotApiCall[];
}): Promise<ToolContractRunResult["artifactPaths"]> {
  await rm(input.artifactDir, { recursive: true, force: true });
  await mkdir(input.artifactDir, { recursive: true });

  const artifactPaths = {
    proposals: path.join(input.artifactDir, "proposals.json"),
    mockToolCalls: path.join(input.artifactDir, "mock-tool-calls.json"),
    mockToolResults: path.join(input.artifactDir, "mock-tool-results.json"),
    connectorResults: path.join(input.artifactDir, "connector-results.json"),
    onebotApiCalls: path.join(input.artifactDir, "onebot-api-calls.json"),
    report: path.join(input.artifactDir, "report.md")
  };

  await Promise.all([
    writeJson(artifactPaths.proposals, input.proposals),
    writeJson(artifactPaths.mockToolCalls, input.mockToolCalls),
    writeJson(artifactPaths.mockToolResults, input.mockToolResults),
    writeJson(artifactPaths.connectorResults, input.connectorResults),
    writeJson(artifactPaths.onebotApiCalls, input.onebotApiCalls),
    writeFile(artifactPaths.report, renderReport(input), "utf8")
  ]);

  return artifactPaths;
}

function renderReport(input: {
  proposals: ActionProposal[];
  mockToolCalls: MockToolCall[];
  connectorResults: ToolExecutionResult[];
  onebotApiCalls: OneBotApiCall[];
}): string {
  return [
    "# Tool Contract E2E",
    "",
    "- Runtime path: action proposal -> tool execution -> connector call",
    `- Proposed tools: ${input.proposals.map((item) => item.toolName).join(", ")}`,
    `- Mock tool calls: ${input.mockToolCalls
      .map((item) => item.toolName)
      .join(", ")}`,
    `- Connector result statuses: ${input.connectorResults
      .map((item) => item.status)
      .join(", ")}`,
    `- OneBot API calls: ${input.onebotApiCalls
      .map((item) => item.action)
      .join(", ")}`,
    ""
  ].join("\n");
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
