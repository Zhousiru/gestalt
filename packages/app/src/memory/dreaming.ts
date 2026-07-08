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
import { ToolLoopAgent, hasToolCall, stepCountIs, tool } from "ai";
import { z } from "zod";
import type { CanonicalEvent } from "../events/schemas";
import type { GestaltConfig } from "../home/loadConfig";
import type { GestaltHome } from "../home/resolveGestaltHome";
import {
  createLanguageModelFromConfig,
  readModelTemperature,
  snapshotStepRequest,
  snapshotStepResponse,
  type ModelRequestSnapshot,
  type ModelResponseSnapshot
} from "../model/aiSdkModel";
import type { MessageWindow, SessionEventRecord } from "../session/schemas";
import type { ToolExecutionResult } from "../tools/executeActions";
import type { ActionProposal } from "../tools/schemas";
import type { MemoryFragment } from "./store";

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
) => Promise<void>;

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
        await options.dream({ ...input, bash });
        const after = await snapshotMemoryFiles(input.home.memoriesDir);
        return {
          status: "completed",
          startedAt,
          endedAt: input.now().toISOString(),
          commands: bash.commands,
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
      await runDreamingToolLoop(config, buildDreamingPrompt(input), input, options);
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

interface DreamingPrompt {
  instructions: string;
  prompt: string;
}

function buildDreamingPrompt(input: DreamingBashAgentInput): DreamingPrompt {
  const participants = getParticipantSummaries(input.eventRecords);
  const memories = input.memories
    .map(
      (memory) =>
        `# ${memory.relativePath}\n${memory.content.trim() || "(empty)"}`
    )
    .join("\n\n");
  const proposedActions = input.proposedActions
    .map(
      (action) =>
        `- ${action.toolName}: ${JSON.stringify(action.params)}${
          action.reason ? ` (${action.reason})` : ""
        }`
    )
    .join("\n");
  const toolResults = input.toolResults
    .map(
      (result) =>
        `- ${result.proposal.toolName}: ${result.status}${
          result.reason ? ` (${result.reason})` : ""
        }`
      )
    .join("\n");

  return {
    instructions: [
      "You are the dreaming memory maintainer for a persona group-chat runtime.",
      "You maintain Markdown files by calling the bash tool.",
      "The bash tool runs in a virtual filesystem whose writable memory folder is /memories.",
      "Do not write bash commands in normal message text; call the bash tool instead.",
      "The bash command argument must be executable shell code, not an explanation or status sentence.",
      "If a bash command fails, inspect the tool result and recover with another bash command.",
      "Use concise bash commands. Prefer cat, mkdir, printf, test, and redirection.",
      "Always inspect relevant index files before writing.",
      "Update self memory under /memories/self/ and participant memory under /memories/users/<id>/.",
      "If the transcript asks to remember explicit facts or wording, preserve the concrete meaning and important phrases.",
      "If the transcript corrects an existing memory, edit or replace the old claim instead of appending a contradictory new note.",
      "If the transcript says a memory is stale or no longer current, delete or rewrite the stale wording so it no longer reads as current truth.",
      "Never access files outside /memories.",
      "When no more memory changes are needed, call the finish_dreaming tool.",
      "Do not answer with status JSON in normal message text."
    ].join("\n"),
    prompt: [
        "Memory root layout:",
        "- /memories/self/index.md",
        "- /memories/self/<subject>.md",
        "- /memories/users/<id>/index.md",
        "- /memories/users/<id>/<subject>.md",
        "",
        "Participants:",
        participants || "(none)",
        "",
        "Injected memory:",
        memories || "(none)",
        "",
        "Turn transcript:",
        input.transcript,
        "",
        "Agent proposed actions:",
        proposedActions || "(none)",
        "",
        "Tool results:",
        toolResults || "(none)",
        "",
        "Task:",
        "Use the bash tool to update useful long-term memory for self and participants.",
        "When creating or editing files, keep content short, inspectable, and narrative.",
        "If the transcript names specific target memory files, update those files through the bash tool.",
        "Prefer correcting, pruning, or rewriting existing memory over piling up conflicting notes."
      ].join("\n")
  };
}

async function runDreamingToolLoop(
  config: GestaltConfig,
  dreamingPrompt: DreamingPrompt,
  input: DreamingBashAgentInput,
  options: CreateAiSdkDreamingRunnerOptions
): Promise<void> {
  const maxModelTurns = options.maxModelTurns ?? 1000;
  const timeoutMs = options.timeoutMs ?? 360_000;
  const resolved = createLanguageModelFromConfig(config, options);
  const temperature = options.temperature ?? readModelTemperature(config) ?? 1;
  const agent = new ToolLoopAgent({
    id: "gestalt-dreaming",
    model: resolved.languageModel,
    instructions: dreamingPrompt.instructions,
    tools: {
      bash: tool({
        description:
          "Run one executable bash command in a virtual filesystem. Only /memories is writable and persistent. Do not pass natural-language explanations as commands.",
        inputSchema: z
          .object({
            command: z
              .string()
              .min(1)
              .describe(
                "Executable shell code to run. Use paths under /memories for memory files. Examples: cat /memories/self/index.md ; printf 'text' >> /memories/users/alice/index.md"
              )
          })
          .strict(),
        async execute({ command }) {
          return input.bash.exec(command);
        }
      }),
      finish_dreaming: tool({
        description:
          "Finish the dreaming pass after all useful memory inspection and updates are complete.",
        inputSchema: z
          .object({
            summary: z
              .string()
              .min(1)
              .describe(
                "Short summary of what memory was updated, or why no update was needed."
              )
          })
          .strict()
      })
    },
    temperature,
    ...(resolved.providerOptions
      ? { providerOptions: resolved.providerOptions }
      : {}),
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
      options.onRequest?.(
        snapshotStepRequest(event, {
          providerName: resolved.providerName,
          modelName: resolved.modelName,
          temperature
        })
      );
    },
    onStepEnd(step) {
      options.onResponse?.(snapshotStepResponse(step));
    }
  });

  const result = await agent.generate({
    prompt: dreamingPrompt.prompt,
    timeout: {
      totalMs: timeoutMs
    }
  });

  if (!result.toolCalls.some((call) => call.toolName === "finish_dreaming")) {
    throw new Error(`Dreaming model exceeded ${maxModelTurns} model turns.`);
  }
}

function getParticipantSummaries(records: SessionEventRecord[]): string {
  const participants = new Map<string, string>();
  for (const record of records) {
    if (record.event.type === "MessageReceived") {
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
