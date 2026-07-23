import { randomUUID } from "node:crypto";
import {
  InMemoryFs,
  MountableFs,
  OverlayFs
} from "just-bash";
import { ToolLoopAgent, hasToolCall, stepCountIs, tool } from "ai";
import { z } from "zod";
import type { MessageReceivedEvent } from "../events/schemas";
import type { GestaltConfig } from "../home/loadConfig";
import type { GestaltHome } from "../home/resolveGestaltHome";
import {
  createLanguageModelFromConfig,
  readModelTemperature,
  type CreateAiSdkModelFromConfigOptions
} from "../model/aiSdkModel";
import type { SessionEventRecord, SessionDiagnostics } from "../session/schemas";
import {
  INSPECT_TOOL_PROMPTS,
  renderInspectSystemPrompt,
  renderInspectTaskPrompt,
  type RenderedPrompt
} from "../prompts";
import {
  createPhaseBash,
  type BashCommandResult,
  type PhaseBash
} from "../tools/bash";

export interface InspectCommand {
  query: string;
}

export type InspectBashCommandResult = BashCommandResult;
export type InspectBashTool = PhaseBash;

export interface InspectRunInput {
  home: GestaltHome;
  config: GestaltConfig;
  eventRecord: SessionEventRecord;
  command: InspectCommand;
  sessionDiagnostics: SessionDiagnostics;
  now: () => Date;
}

export interface InspectRunResult {
  id: string;
  status: "completed" | "failed";
  startedAt: string;
  endedAt: string;
  commands: InspectBashCommandResult[];
  reportText?: string;
  error?: string;
}

export interface InspectRunner {
  run(input: InspectRunInput): Promise<InspectRunResult>;
}

export interface CreateAiSdkInspectRunnerOptions
  extends Pick<
    CreateAiSdkModelFromConfigOptions,
    "apiKeyEnvOverride" | "fetch" | "headers"
  > {
  temperature?: number;
  timeoutMs?: number;
  maxModelTurns?: number;
}

interface InspectPrompt {
  instructions: RenderedPrompt;
  prompt: RenderedPrompt;
}

const inspectCommandPattern = /(?:^|\s)\/inspect(?:\s+([\s\S]*))?$/;
const defaultInspectTimeoutMs = 300_000;
const defaultInspectMaxModelTurns = 1000;

export function parseInspectCommand(
  event: MessageReceivedEvent
): InspectCommand | undefined {
  const text = event.message.text.trim();
  const match = text.match(inspectCommandPattern);
  if (!match) {
    return undefined;
  }
  return {
    query: match[1]?.trim() ?? ""
  };
}

export function createAiSdkInspectRunner(
  config: GestaltConfig,
  options: CreateAiSdkInspectRunnerOptions = {}
): InspectRunner {
  return {
    async run(input) {
      return runAiSdkInspectAgent(config, input, options);
    }
  };
}

export function createInspectBashTool(
  home: GestaltHome
): InspectBashTool {
  const fs = new MountableFs({
    base: new InMemoryFs(),
    mounts: [
      {
        mountPoint: "/sessions",
        filesystem: new OverlayFs({
          root: home.sessionsDir,
          mountPoint: "/",
          readOnly: true
        })
      },
      {
        mountPoint: "/traces",
        filesystem: new OverlayFs({
          root: home.tracesDir,
          mountPoint: "/",
          readOnly: true
        })
      }
    ]
  });
  return createPhaseBash({
    fs,
    cwd: "/",
    customCommands: []
  });
}

async function runAiSdkInspectAgent(
  config: GestaltConfig,
  input: InspectRunInput,
  options: CreateAiSdkInspectRunnerOptions
): Promise<InspectRunResult> {
  const startedAt = input.now().toISOString();
  const id = randomUUID();
  const bash = createInspectBashTool(input.home);
  const prompt = buildInspectPrompt(input);
  const resolved = createLanguageModelFromConfig(config, options);
  const temperature = options.temperature ?? readModelTemperature(config) ?? 1;
  const timeoutMs = options.timeoutMs ?? defaultInspectTimeoutMs;
  const maxModelTurns = options.maxModelTurns ?? defaultInspectMaxModelTurns;
  let reportText: string | undefined;

  const agent = new ToolLoopAgent({
    id: "gestalt-inspect",
    model: resolved.languageModel,
    instructions: prompt.instructions.content,
    tools: {
      bash: tool({
        description: INSPECT_TOOL_PROMPTS.bash.description,
        inputSchema: z
          .object({
            command: z
              .string()
              .min(1)
              .describe(INSPECT_TOOL_PROMPTS.bash.parameters.command)
          })
          .strict(),
        async execute({ command }) {
          return bash.exec(command);
        }
      }),
      send_inspect_report: tool({
        description: INSPECT_TOOL_PROMPTS.send_inspect_report.description,
        inputSchema: z
          .object({
            report: z
              .string()
              .min(1)
              .describe(
                INSPECT_TOOL_PROMPTS.send_inspect_report.parameters.report
              )
          })
          .strict(),
        async execute({ report }) {
          reportText = normalizeInspectReportText(report);
          return {
            status: "accepted"
          };
        }
      })
    },
    temperature,
    ...(resolved.providerOptions
      ? { providerOptions: resolved.providerOptions }
      : {}),
    stopWhen: [hasToolCall("send_inspect_report"), stepCountIs(maxModelTurns)],
    include: {
      requestBody: true,
      requestMessages: true,
      responseBody: true
    },
    prepareStep({ steps }) {
      if (steps.length >= maxModelTurns - 1) {
        return {
          toolChoice: {
            type: "tool",
            toolName: "send_inspect_report"
          }
        };
      }
      return {
        toolChoice: "auto"
      };
    }
  });

  try {
    const result = await agent.generate({
      prompt: prompt.prompt.content,
      timeout: {
        totalMs: timeoutMs
      }
    });
    const finalReport = normalizeInspectReportText(
      reportText ??
        readReportToolText(result) ??
        buildFallbackInspectReport(
          input,
          bash.commands,
          `模型没有调用 send_inspect_report。AI SDK maxModelTurns=${maxModelTurns}。`
        )
    );
    return {
      id,
      status: "completed",
      startedAt,
      endedAt: input.now().toISOString(),
      commands: bash.commands,
      reportText: finalReport
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const fallbackReportText = normalizeInspectReportText(
      buildFallbackInspectReport(
        input,
        bash.commands,
        `${errorMessage} AI SDK maxModelTurns=${maxModelTurns}。`
      )
    );
    return {
      id,
      status: "completed",
      startedAt,
      endedAt: input.now().toISOString(),
      commands: bash.commands,
      reportText: fallbackReportText,
      error: errorMessage
    };
  }
}

function buildInspectPrompt(input: InspectRunInput): InspectPrompt {
  const event = input.eventRecord.event;
  const conversation = event.conversation;
  const latestConversation = input.sessionDiagnostics.conversations.find(
    (candidate) =>
      candidate.conversation.kind === conversation.kind &&
      candidate.conversation.id === conversation.id
  );

  return {
    instructions: renderInspectSystemPrompt(),
    prompt: renderInspectTaskPrompt({
      now: input.now().toISOString(),
      query: input.command.query,
      conversation: `${conversation.kind}:${conversation.id}`,
      eventId: event.id,
      sessionRecordId: input.eventRecord.id,
      messageId: event.message.id,
      sender: `${event.sender.displayName ?? event.sender.id} (${event.sender.id})`,
      receivedAt: input.eventRecord.receivedAt,
      text: event.message.text,
      conversationSummary: latestConversation
        ? [
            `- events: ${latestConversation.events.length}`,
            `- windows: ${latestConversation.windows.length}`,
            `- turns: ${latestConversation.turns.length}`,
            `- loopExits: ${latestConversation.loopExits.length}`
          ].join("\n")
        : "(conversation not found in current diagnostics)"
    })
  };
}

function readReportToolText(result: unknown): string | undefined {
  if (!result || typeof result !== "object") {
    return undefined;
  }
  const toolCalls = (result as { toolCalls?: unknown }).toolCalls;
  if (!Array.isArray(toolCalls)) {
    return undefined;
  }
  for (const call of toolCalls) {
    if (!call || typeof call !== "object") {
      continue;
    }
    const toolName = (call as { toolName?: unknown }).toolName;
    const input = (call as { input?: unknown }).input;
    if (toolName === "send_inspect_report" && input && typeof input === "object") {
      const report = (input as { report?: unknown }).report;
      if (typeof report === "string" && report.trim()) {
        return report;
      }
    }
  }
  return undefined;
}

function normalizeInspectReportText(text: string): string {
  return stripMarkdownFormatting(text).trim();
}

function stripMarkdownFormatting(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, (match) =>
      match.replace(/```[a-zA-Z0-9_-]*\n?/g, "").replace(/```/g, "")
    )
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}[-*+]\s+/gm, "")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\n{3,}/g, "\n\n");
}

function buildFallbackInspectReport(
  input: InspectRunInput,
  commands: InspectBashCommandResult[],
  reason: string
): string {
  const event = input.eventRecord.event;
  const lastCommand = commands.at(-1);
  const lastCommandSummary = lastCommand
    ? `最后一条查询命令 exit=${lastCommand.exitCode}，stdout ${lastCommand.stdout.length} 字符，stderr ${lastCommand.stderr.length} 字符。`
    : "inspect agent 还没有成功执行 bash 查询。";

  return [
    "inspect 没能生成完整诊断，但这不是正常聊天动作失败。",
    `原因：${reason}`,
    `请求：${input.command.query || event.message.text}`,
    `会话：${event.conversation.kind}:${event.conversation.id}，session_record_id=${input.eventRecord.id}，message_id=${event.message.id}。`,
    `已执行查询数：${commands.length}。${lastCommandSummary}`,
    "建议缩小问题范围，直接指定要解释的消息文本、message_id、turn id 或 trace id。"
  ].join(" ");
}
