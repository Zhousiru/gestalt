import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  Bash,
  InMemoryFs,
  MountableFs,
  ReadWriteFs,
  type BashExecResult
} from "just-bash";
import { ToolLoopAgent, hasToolCall, stepCountIs } from "ai";
import { isSelfMessageEvent } from "../events/helpers";
import type { CanonicalEvent } from "../events/schemas";
import type { GestaltConfig } from "../home/loadConfig";
import type { GestaltHome } from "../home/resolveGestaltHome";
import {
  createModelSessionProviderOptions,
  buildActionTools,
  createModelStepRecorder,
  createLanguageModelFromConfig,
  readModelTemperature,
  snapshotStepRequest,
  snapshotStepResponse,
  type ModelRequestSnapshot,
  type ModelResponseSnapshot
} from "../model/aiSdkModel";
import { buildDreamingTools, dreamingToolOrder } from "../model/dreamingTools";
import type {
  ModelSessionContinuation,
  ModelStepTraceSnapshot
} from "../model/session";
import type { MessageWindow, SessionEventRecord } from "../session/schemas";
import type { ToolExecutionResult } from "../tools/executeActions";
import type { ActionProposal } from "../tools/schemas";
import type { MemoryFragment } from "./store";
import { renderDreamingTaskPrompt } from "../prompts/dreaming";

export interface MemoryBashCommandResult {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface MemoryBashTool {
  readonly commands: MemoryBashCommandResult[];
  exec(command: string): Promise<MemoryBashCommandResult>;
}

export interface DreamingRunInput {
  home: GestaltHome;
  event: CanonicalEvent;
  window: MessageWindow;
  eventRecords: SessionEventRecord[];
  transcript: string;
  memories: MemoryFragment[];
  proposedActions: ActionProposal[];
  toolResults: ToolExecutionResult[];
  modelContinuation?: ModelSessionContinuation;
  now: () => Date;
}

export interface DreamingRunResult {
  status: "completed" | "skipped" | "failed";
  startedAt: string;
  endedAt: string;
  commands: MemoryBashCommandResult[];
  addedFiles: string[];
  changedFiles: string[];
  removedFiles: string[];
  modelSteps?: ModelStepTraceSnapshot[];
  error?: string;
}

export interface DreamingRunner {
  run(input: DreamingRunInput): Promise<DreamingRunResult>;
}

export interface DreamingBashAgentInput extends DreamingRunInput {
  bash: MemoryBashTool;
}

export type DreamingBashAgent = (
  input: DreamingBashAgentInput
) => Promise<void | { modelSteps?: ModelStepTraceSnapshot[] }>;

export interface CreateBashDreamingRunnerOptions {
  dream: DreamingBashAgent;
}

export interface CreateAiSdkDreamingRunnerOptions {
  temperature?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
  onRequest?: (request: ModelRequestSnapshot) => void;
  onResponse?: (response: ModelResponseSnapshot) => void;
  maxModelTurns?: number;
  apiKeyEnvOverride?: string;
}

interface MemoryFileSnapshot {
  path: string;
  bytes: number;
  sha256: string;
}

export function createNoopDreamingRunner(): DreamingRunner {
  return {
    async run(input) {
      const now = input.now().toISOString();
      return {
        status: "skipped",
        startedAt: now,
        endedAt: now,
        commands: [],
        addedFiles: [],
        changedFiles: [],
        removedFiles: []
      };
    }
  };
}

export function createBashDreamingRunner(
  options: CreateBashDreamingRunnerOptions
): DreamingRunner {
  return {
    async run(input) {
      const startedAt = input.now().toISOString();
      await mkdir(input.home.memoriesDir, { recursive: true });
      const before = await snapshotMemoryFiles(input.home.memoriesDir);
      const bash = createMemoryBashTool(input.home);

      try {
        const dreamResult = await options.dream({ ...input, bash });
        const after = await snapshotMemoryFiles(input.home.memoriesDir);
        return {
          status: "completed",
          startedAt,
          endedAt: input.now().toISOString(),
          commands: bash.commands,
          ...(dreamResult?.modelSteps ? { modelSteps: dreamResult.modelSteps } : {}),
          ...diffMemorySnapshots(before, after)
        };
      } catch (error) {
        const after = await snapshotMemoryFiles(input.home.memoriesDir);
        return {
          status: "failed",
          startedAt,
          endedAt: input.now().toISOString(),
          commands: bash.commands,
          ...diffMemorySnapshots(before, after),
          error: error instanceof Error ? error.message : String(error)
        };
      }
    }
  };
}

export function createAiSdkDreamingRunner(
  config: GestaltConfig,
  options: CreateAiSdkDreamingRunnerOptions = {}
): DreamingRunner {
  return createBashDreamingRunner({
    async dream(input) {
      return {
        modelSteps: await runDreamingToolLoop(
          config,
          input,
          options
        )
      };
    }
  });
}

export function createMemoryBashTool(home: GestaltHome): MemoryBashTool {
  const commands: MemoryBashCommandResult[] = [];
  const fs = new MountableFs({
    base: new InMemoryFs(),
    mounts: [
      {
        mountPoint: "/memories",
        filesystem: new ReadWriteFs({ root: home.memoriesDir })
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

async function runDreamingToolLoop(
  config: GestaltConfig,
  input: DreamingBashAgentInput,
  options: CreateAiSdkDreamingRunnerOptions
): Promise<ModelStepTraceSnapshot[]> {
  const maxModelTurns = options.maxModelTurns ?? 1000;
  const timeoutMs = options.timeoutMs ?? 360_000;
  const resolved = createLanguageModelFromConfig(config, options);
  const temperature = options.temperature ?? readModelTemperature(config) ?? 1;
  const modelStepRecorder = createModelStepRecorder(input.now);
  const pendingExchangeRequests: Array<{
    request: ModelRequestSnapshot;
    startedAt: string;
  }> = [];
  const continuation = input.modelContinuation;
  if (!continuation) {
    throw new Error(
      "Dreaming requires a completed action model session continuation."
    );
  }
  const dreamingTask = renderDreamingTaskPrompt({
    participants: getParticipantSummaries(input.eventRecords)
  });
  const providerOptions = createModelSessionProviderOptions(
    resolved.providerOptions,
    resolved.providerName,
    continuation.providerSessionId,
    continuation.promptCacheEnabled,
    continuation.promptCacheTtl
  );
  const tools = {
    ...buildActionTools(continuation.actionTools),
    ...buildDreamingTools(input.bash)
  };
  const agent = new ToolLoopAgent({
    id: "gestalt-dreaming",
    model: resolved.languageModel,
    instructions: continuation.instructions,
    tools,
    temperature,
    toolOrder: [
      ...continuation.actionTools.map((candidate) => candidate.name),
      ...dreamingToolOrder
    ],
    ...(providerOptions ? { providerOptions } : {}),
    stopWhen: [hasToolCall("finish_dreaming"), stepCountIs(maxModelTurns)],
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
            toolName: "finish_dreaming"
          }
        };
      }
      return {
        toolChoice: "auto"
      };
    },
    onStepStart(event) {
      const request = snapshotStepRequest(event, {
        providerName: resolved.providerName,
        modelName: resolved.modelName,
        temperature,
        sessionId: continuation.providerSessionId,
        promptCacheEnabled: continuation.promptCacheEnabled,
        prompt: {
          id: dreamingTask.id,
          contentHash: dreamingTask.contentHash,
          ...(continuation.prompt.toolPromptHash
            ? { toolPromptHash: continuation.prompt.toolPromptHash }
            : {})
        }
      });
      modelStepRecorder.recordRequest(request);
      pendingExchangeRequests.push({
        request,
        startedAt: input.now().toISOString()
      });
      options.onRequest?.(request);
    },
    async onStepEnd(step) {
      const response = snapshotStepResponse({
        ...step,
        responseMessages: step.response.messages
      });
      modelStepRecorder.recordResponse(response);
      const exchangeRequest = pendingExchangeRequests.shift();
      if (exchangeRequest) {
        await continuation.exchangeSink?.onStep({
          purpose: "dreaming",
          request: exchangeRequest.request,
          response,
          status: "completed",
          startedAt: exchangeRequest.startedAt,
          endedAt: input.now().toISOString()
        });
      }
      options.onResponse?.(response);
    }
  });

  const timeout = { totalMs: timeoutMs };
  let result: Awaited<ReturnType<typeof agent.generate>>;
  try {
    result = await agent.generate({
      messages: [
        ...continuation.messages,
        {
          role: "user",
          content: dreamingTask.content
        }
      ],
      timeout
    });
  } catch (error) {
    const unfinishedExchanges = pendingExchangeRequests.splice(
      0,
      pendingExchangeRequests.length
    );
    const endedAt = input.now().toISOString();
    for (const exchangeRequest of unfinishedExchanges) {
      await continuation.exchangeSink?.onStep({
        purpose: "dreaming",
        request: exchangeRequest.request,
        status: "failed",
        startedAt: exchangeRequest.startedAt,
        endedAt
      });
    }
    throw error;
  }

  if (!result.toolCalls.some((call) => call.toolName === "finish_dreaming")) {
    throw new Error(`Dreaming model exceeded ${maxModelTurns} model turns.`);
  }
  return modelStepRecorder.steps;
}

function getParticipantSummaries(records: SessionEventRecord[]): string {
  const participants = new Map<string, string>();
  for (const record of records) {
    if (
      record.event.type === "MessageReceived" &&
      !isSelfMessageEvent(record.event)
    ) {
      participants.set(
        record.event.sender.id,
        record.event.sender.displayName ?? record.event.sender.id
      );
    }
  }

  return Array.from(participants.entries())
    .map(([id, name]) => `- ${name} (id=${id}, path=users/${id})`)
    .join("\n");
}

async function snapshotMemoryFiles(
  memoriesDir: string
): Promise<MemoryFileSnapshot[]> {
  const files = await collectMemoryFiles(memoriesDir, memoriesDir);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function collectMemoryFiles(
  root: string,
  directory: string
): Promise<MemoryFileSnapshot[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: MemoryFileSnapshot[] = [];
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    const relativePath = normalizeMemoryPath(path.relative(root, absolutePath));
    if (isSecretLikePath(relativePath)) {
      continue;
    }

    if (entry.isDirectory()) {
      files.push(...(await collectMemoryFiles(root, absolutePath)));
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }

    const content = await readFile(absolutePath);
    const fileStat = await stat(absolutePath);
    files.push({
      path: relativePath,
      bytes: fileStat.size,
      sha256: createHash("sha256").update(content).digest("hex")
    });
  }

  return files;
}

function diffMemorySnapshots(
  before: MemoryFileSnapshot[],
  after: MemoryFileSnapshot[]
): Pick<DreamingRunResult, "addedFiles" | "changedFiles" | "removedFiles"> {
  const beforeByPath = new Map(before.map((file) => [file.path, file]));
  const afterByPath = new Map(after.map((file) => [file.path, file]));

  return {
    addedFiles: after
      .filter((file) => !beforeByPath.has(file.path))
      .map((file) => file.path),
    changedFiles: after
      .filter((file) => {
        const beforeFile = beforeByPath.get(file.path);
        return beforeFile !== undefined && beforeFile.sha256 !== file.sha256;
      })
      .map((file) => file.path),
    removedFiles: before
      .filter((file) => !afterByPath.has(file.path))
      .map((file) => file.path)
  };
}

function toCommandResult(
  command: string,
  result: BashExecResult
): MemoryBashCommandResult {
  return {
    command,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode
  };
}

function normalizeMemoryPath(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

function isSecretLikePath(relativePath: string): boolean {
  const normalized = relativePath.toLowerCase();
  return (
    normalized === ".env" ||
    normalized.startsWith(".env.") ||
    normalized.includes("secret")
  );
}
