import { randomUUID } from "node:crypto";
import {
  Bash,
  InMemoryFs,
  MountableFs,
  OverlayFs,
  type BashExecResult
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
import type { SessionEventRecord, SessionSnapshot } from "../session/schemas";

export interface InspectCommand {
  query: string;
}

export interface InspectBashCommandResult {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface InspectBashTool {
  readonly commands: InspectBashCommandResult[];
  exec(command: string): Promise<InspectBashCommandResult>;
}

export interface InspectRunInput {
  home: GestaltHome;
  config: GestaltConfig;
  eventRecord: SessionEventRecord;
  command: InspectCommand;
  sessionSnapshot: SessionSnapshot;
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
  instructions: string;
  prompt: string;
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
  const commands: InspectBashCommandResult[] = [];
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
  const bash = new Bash({
    fs,
    cwd: "/",
    defenseInDepth: true
  });

  return {
    commands,

    async exec(command) {
      const result = toCommandResult(command, await bash.exec(command));
      commands.push(result);
      return result;
    }
  };
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
    instructions: prompt.instructions,
    tools: {
      bash: tool({
        description:
          "Run one read-only bash command in a virtual filesystem. Mounted evidence: /sessions and /traces. Use this to inspect JSONL files before reporting.",
        inputSchema: z
          .object({
            command: z
              .string()
              .min(1)
              .describe(
                "Executable shell code for read-only inspection. Prefer ls, cat, head, tail, grep-like shell pipelines, and python/json parsing. Do not write files."
              )
          })
          .strict(),
        async execute({ command }) {
          return bash.exec(command);
        }
      }),
      send_inspect_report: tool({
        description:
          "Submit the final inspect diagnosis. This does not send directly to the chat platform; the runtime will send the report text after this tool is called.",
        inputSchema: z
          .object({
            report: z
              .string()
              .min(1)
              .describe(
                "Final diagnosis in plain text. Do not use Markdown formatting, bullet lists, tables, headings, code fences, or links."
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
      prompt: prompt.prompt,
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
  const latestConversation = input.sessionSnapshot.conversations.find(
    (candidate) =>
      candidate.conversation.kind === conversation.kind &&
      candidate.conversation.id === conversation.id
  );

  return {
    instructions: [
      "You are the inspect agent for a dev/debug chatbot runtime.",
      "Your job is to answer why a message, tool call, window, turn, or loop decision happened.",
      "You must ground the answer in session and trace evidence.",
      "You have a read-only bash tool with virtual filesystem mounts:",
      "- /sessions contains rotated realtime session snapshots as JSONL.",
      "- /traces contains rotated agent turn traces as JSONL.",
      "Do not attempt to modify files. The mounted evidence is read-only.",
      "Use bash to inspect the evidence before answering.",
      "Mention missing evidence explicitly instead of guessing.",
      "Keep the report concise and useful for an engineer.",
      "When you have enough evidence, call send_inspect_report with the final diagnosis.",
      "Do not finish in normal text. send_inspect_report is the only valid way to complete inspect.",
      "The report must be plain text only. Do not use Markdown formatting, bullet lists, tables, headings, code fences, or links."
    ].join("\n"),
    prompt: [
      "Current time:",
      input.now().toISOString(),
      "",
      "User inspect request:",
      input.command.query || "(no explicit inspect query; diagnose the current conversation state)",
      "",
      "Current inspect command event:",
      `- conversation: ${conversation.kind}:${conversation.id}`,
      `- event_id: ${event.id}`,
      `- session_seq: ${input.eventRecord.seq}`,
      `- message_id: ${event.message.id}`,
      `- sender: ${event.sender.displayName ?? event.sender.id} (${event.sender.id})`,
      `- received_at: ${input.eventRecord.receivedAt}`,
      `- text: ${event.message.text}`,
      "",
      "Current conversation snapshot summary:",
      latestConversation
        ? [
            `- nextSeq: ${latestConversation.nextSeq}`,
            `- events: ${latestConversation.events.length}`,
            `- windows: ${latestConversation.windows.length}`,
            `- turns: ${latestConversation.turns.length}`,
            `- loopExits: ${latestConversation.loopExits.length}`
          ].join("\n")
        : "(conversation not found in current snapshot)",
      "",
      "Suggested first steps:",
      "- List /sessions and /traces.",
      "- Read the latest session JSONL line for the current conversation.",
      "- Find the relevant self message/action/turn if the request mentions one.",
      "- Use the turn traceId to inspect /traces when available.",
      "- Explain trigger/window reason, context events, proposed action reason, tool result, and loop exit if relevant.",
      "- Finish by calling send_inspect_report.",
      "- Final report style: plain text only, no Markdown."
    ].join("\n")
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
    `会话：${event.conversation.kind}:${event.conversation.id}，session seq=${input.eventRecord.seq}，message_id=${event.message.id}。`,
    `已执行查询数：${commands.length}。${lastCommandSummary}`,
    "建议缩小问题范围，直接指定要解释的消息文本、message_id、turn id 或 trace id。"
  ].join(" ");
}

function toCommandResult(
  command: string,
  result: BashExecResult
): InspectBashCommandResult {
  return {
    command,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode
  };
}
