import { randomUUID } from "node:crypto";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  hasToolCall,
  ToolLoopAgent,
  stepCountIs,
  tool,
  type LanguageModel,
  type ModelMessage,
  type ToolSet
} from "ai";
import { z } from "zod";
import type { CompiledContext } from "../context/compileContext";
import type { MessageReceivedEvent } from "../events/schemas";
import type { GestaltConfig } from "../home/loadConfig";
import {
  ACTION_TOOL_PROMPTS,
  hashModelToolPrompts,
  renderActionSystemPrompt,
  renderActionToolDescription,
  renderActionWindowPrompt,
  type PromptMetadata,
  type RenderedPrompt
} from "../prompts";
import {
  isTurnSteeredError,
  readTurnAbortError,
  throwIfTurnSteered,
  TurnSteeredError
} from "../runtime/turnSignals";
import {
  executeActions,
  type ToolExecutionResult
} from "../tools/executeActions";
import {
  ActionProposalSchema,
  type ActionProposal,
  type ToolDefinition
} from "../tools/schemas";
import {
  attachModelStepsToError,
  type ModelActionResult,
  type ModelClient,
  type ModelRunOptions,
  type ModelSession,
  type ModelSessionContinuation,
  type ModelStepTraceSnapshot
} from "./session";
import { buildDreamingTools, dreamingToolOrder } from "./dreamingTools";

export interface ModelMessageSnapshot {
  role: string;
  content: string;
}

export interface ModelToolCallSnapshot {
  id: string;
  name: string;
  input: unknown;
}

export interface ModelToolResultSnapshot {
  id: string;
  name: string;
  output?: unknown;
  error?: unknown;
}

export type ModelJsonValue =
  | string
  | number
  | boolean
  | null
  | ModelJsonValue[]
  | { [key: string]: ModelJsonValue | undefined };

export type ModelProviderOptions = Record<
  string,
  { [key: string]: ModelJsonValue | undefined }
>;

export type ModelToolChoiceMode = "required" | "auto" | "none";

export interface ModelRequestSnapshot {
  provider: string;
  model: string;
  temperature: number;
  stepNumber: number;
  messages: ModelMessageSnapshot[];
  tools: string[];
  toolChoice?: unknown;
  requestBody?: unknown;
  sessionId?: string;
  promptCacheEnabled?: boolean;
  prompt?: PromptMetadata;
}

export interface ModelResponseSnapshot {
  content?: string;
  finishReason?: string;
  stepNumber?: number;
  toolCalls?: ModelToolCallSnapshot[];
  toolResults?: ModelToolResultSnapshot[];
  usage?: unknown;
  cacheUsage?: ModelCacheUsageSnapshot;
  requestBody?: unknown;
  responseBody?: unknown;
}

export interface ModelCacheUsageSnapshot {
  readTokens: number;
  writeTokens?: number;
}

export interface ResolvedAiSdkLanguageModel {
  languageModel: LanguageModel;
  providerName: string;
  modelName: string;
  baseUrl: string;
  apiKeyEnv: string;
  providerOptions?: ModelProviderOptions;
  toolChoice?: ModelToolChoiceMode;
  promptCacheEnabled?: boolean;
  promptCacheTtl?: "5m" | "1h";
}

export interface CreateAiSdkModelOptions {
  languageModel: LanguageModel;
  modelName: string;
  providerName?: string;
  providerOptions?: ModelProviderOptions;
  toolChoice?: ModelToolChoiceMode;
  temperature?: number;
  timeoutMs?: number;
  maxSteps?: number;
  promptCacheEnabled?: boolean;
  promptCacheTtl?: "5m" | "1h";
  now?: () => Date;
  onRequest?: (request: ModelRequestSnapshot) => void;
  onResponse?: (response: ModelResponseSnapshot) => void;
}

export interface CreateAiSdkModelFromConfigOptions
  extends Omit<CreateAiSdkModelOptions, "languageModel" | "modelName"> {
  apiKeyEnvOverride?: string;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
}

export function createAiSdkModel(options: CreateAiSdkModelOptions): ModelClient {
  const now = options.now ?? (() => new Date());
  const temperature = options.temperature ?? 1;
  const timeoutMs = options.timeoutMs ?? 300_000;
  const maxSteps = options.maxSteps ?? 1000;
  const providerName = options.providerName ?? "openai-compatible";
  const toolChoice = options.toolChoice;

  return {
    name: options.modelName,
    createSession() {
      return createAiSdkModelSession({
        options,
        now,
        temperature,
        timeoutMs,
        maxSteps,
        providerName,
        toolChoice
      });
    }
  };
}

interface AiSdkModelSessionOptions {
  options: CreateAiSdkModelOptions;
  now: () => Date;
  temperature: number;
  timeoutMs: number;
  maxSteps: number;
  providerName: string;
  toolChoice: ModelToolChoiceMode | undefined;
}

function createAiSdkModelSession(
  sessionOptions: AiSdkModelSessionOptions
): ModelSession {
  const {
    options,
    now,
    temperature,
    timeoutMs,
    maxSteps,
    providerName,
    toolChoice
  } = sessionOptions;
  const sessionId = randomUUID();
  const providerOptions = createModelSessionProviderOptions(
    options.providerOptions,
    providerName,
    sessionId,
    options.promptCacheEnabled ?? false,
    options.promptCacheTtl
  );
  const modelStepRecorder = createModelStepRecorder(now);
  const committedToolResults: ToolExecutionResult[] = [];
  let instructions: string | undefined;
  let sessionPrompt: RenderedPrompt | undefined;
  let messages: ModelMessage[] = [];
  let currentContext: CompiledContext | undefined;
  let attemptController: AbortController | undefined;
  let initialized = false;
  let running = false;

  return {
    get initialized() {
      return initialized;
    },
    get running() {
      return running;
    },

    async run(context, runOptions = {}) {
      if (running) {
        throw new Error("Model session is already running.");
      }
      throwIfTurnSteered(runOptions.signal);
      currentContext = context;
      if (!initialized) {
        sessionPrompt = renderActionSystemPrompt({
          persona: context.persona,
          memories: context.memories
        });
        instructions = sessionPrompt.content;
        messages.push({
          role: "user",
          content: renderActionWindowPrompt(context.transcript).content
        });
        initialized = true;
      } else {
        messages.push({
          role: "user",
          content: renderActionWindowPrompt(context.transcript).content
        });
      }

      const runStepOffset = modelStepRecorder.steps.length;
      const runToolOffset = committedToolResults.length;
      running = true;

      try {
        while (true) {
          const controller = new AbortController();
          attemptController = controller;
          const removeExternalAbort = forwardAbortSignal(
            runOptions.signal,
            controller
          );
          const attemptToolResults: ToolExecutionResult[] = [];
          let committedAttemptTools = 0;
          const attemptContext = currentContext;
          const attemptSessionPrompt = sessionPrompt;
          if (!attemptContext || !instructions || !attemptSessionPrompt) {
            throw new Error("AI SDK model session was not initialized.");
          }
          const attemptRunOptions: ModelRunOptions = {
            ...runOptions,
            signal: controller.signal
          };
          const tools = buildActionTools(attemptContext.tools, {
            context: attemptContext,
            now,
            runOptions: attemptRunOptions,
            executedToolResults: attemptToolResults
          });
          Object.assign(tools, buildDreamingTools());
          runOptions.onModelAttemptStart?.();

          const agent = new ToolLoopAgent({
            id: "gestalt-action-decision",
            model: options.languageModel,
            instructions,
            tools,
            ...(toolChoice !== undefined ? { toolChoice } : {}),
            toolOrder: [
              ...attemptContext.tools.map((candidate) => candidate.name),
              ...dreamingToolOrder
            ],
            ...(providerOptions ? { providerOptions } : {}),
            stopWhen: [hasToolCall("leave"), stepCountIs(maxSteps)],
            temperature,
            include: {
              requestBody: true,
              requestMessages: true,
              responseBody: true
            },
            onStepStart(event) {
              const request = snapshotStepRequest(event, {
                providerName,
                modelName: options.modelName,
                temperature,
                sessionId,
                promptCacheEnabled: options.promptCacheEnabled ?? false,
                prompt: {
                  id: attemptSessionPrompt.id,
                  contentHash: attemptSessionPrompt.contentHash,
                  toolPromptHash: hashModelToolPrompts(
                    attemptContext.tools.map((candidate) => candidate.name)
                  )
                }
              });
              modelStepRecorder.recordRequest(request);
              options.onRequest?.(request);
            },
            onStepEnd(step) {
              const wasSteered =
                controller.signal.aborted && !runOptions.signal?.aborted;
              if (!wasSteered) {
                const requestMessages = step.request.messages;
                if (requestMessages) {
                  messages = [
                    ...requestMessages,
                    ...step.response.messages
                  ] as ModelMessage[];
                }
                committedToolResults.push(
                  ...attemptToolResults.slice(committedAttemptTools)
                );
                committedAttemptTools = attemptToolResults.length;
              }
              const response = snapshotStepResponse(step);
              modelStepRecorder.recordResponse(response);
              options.onResponse?.(response);
            }
          });

          try {
            const result = await agent.generate({
              messages: [...messages],
              timeout: { totalMs: timeoutMs },
              abortSignal: controller.signal
            });
            throwIfTurnSteered(runOptions.signal);
            return collectModelActionResult(
              result.toolCalls,
              committedToolResults.slice(runToolOffset),
              modelStepRecorder.steps.slice(runStepOffset),
              attemptContext.tools
            );
          } catch (error) {
            const thrownError = controller.signal.aborted
              ? readTurnAbortError(controller.signal)
              : error;
            if (
              isTurnSteeredError(thrownError) &&
              !runOptions.signal?.aborted
            ) {
              continue;
            }
            attachModelStepsToError(
              thrownError,
              modelStepRecorder.steps.slice(runStepOffset)
            );
            throw thrownError;
          } finally {
            removeExternalAbort();
          }
        }
      } finally {
        running = false;
        attemptController = undefined;
      }
    },

    steer(context) {
      if (!running) {
        return false;
      }
      currentContext = context;
      messages.push({
        role: "user",
        content: renderActionWindowPrompt(context.transcript).content
      });
      attemptController?.abort(new TurnSteeredError());
      return true;
    },

    continuation(): ModelSessionContinuation | undefined {
      if (!initialized || running || !instructions || !sessionPrompt) {
        return undefined;
      }
      return {
        instructions,
        prompt: {
          id: sessionPrompt.id,
          contentHash: sessionPrompt.contentHash,
          toolPromptHash: hashModelToolPrompts(
            (currentContext?.tools ?? []).map((candidate) => candidate.name)
          )
        },
        messages: [...messages],
        providerSessionId: sessionId,
        promptCacheEnabled: options.promptCacheEnabled ?? false,
        actionTools: [...(currentContext?.tools ?? [])],
        ...(options.promptCacheTtl
          ? { promptCacheTtl: options.promptCacheTtl }
          : {})
      };
    }
  };
}

export function createModelStepRecorder(now: () => Date = () => new Date()): {
  readonly steps: ModelStepTraceSnapshot[];
  recordRequest(request: ModelRequestSnapshot): void;
  recordResponse(response: ModelResponseSnapshot): void;
} {
  const steps: ModelStepTraceSnapshot[] = [];

  return {
    steps,

    recordRequest(request) {
      steps.push({ startedAt: now().toISOString(), request });
    },

    recordResponse(response) {
      const existing =
        findLastStep(steps,
          (candidate) =>
            candidate.request?.stepNumber === response.stepNumber &&
            candidate.response === undefined
        ) ??
        findLastStep(steps,
          (candidate) =>
            candidate.request === undefined &&
            candidate.response?.stepNumber === response.stepNumber
        );
      if (existing) {
        existing.response = response;
        existing.endedAt = now().toISOString();
        return;
      }
      steps.push({ endedAt: now().toISOString(), response });
    }
  };
}

function findLastStep(
  steps: ModelStepTraceSnapshot[],
  predicate: (step: ModelStepTraceSnapshot) => boolean
): ModelStepTraceSnapshot | undefined {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index];
    if (step && predicate(step)) {
      return step;
    }
  }
  return undefined;
}

export function createAiSdkModelFromConfig(
  config: GestaltConfig,
  options: CreateAiSdkModelFromConfigOptions = {}
): ModelClient {
  const resolved = createLanguageModelFromConfig(config, options);
  const temperature = options.temperature ?? readModelTemperature(config);
  return createAiSdkModel({
    ...options,
    languageModel: resolved.languageModel,
    modelName: resolved.modelName,
    providerName: resolved.providerName,
    maxSteps: readModelMaxSteps(config),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(resolved.toolChoice !== undefined
      ? { toolChoice: resolved.toolChoice }
      : {}),
    ...(resolved.providerOptions
      ? { providerOptions: resolved.providerOptions }
      : {}),
    ...(resolved.promptCacheEnabled !== undefined
      ? { promptCacheEnabled: resolved.promptCacheEnabled }
      : {}),
    ...(resolved.promptCacheTtl
      ? { promptCacheTtl: resolved.promptCacheTtl }
      : {})
  });
}

export function createLanguageModelFromConfig(
  config: GestaltConfig,
  options: {
    apiKeyEnvOverride?: string;
    fetch?: typeof fetch;
    headers?: Record<string, string>;
  } = {}
): ResolvedAiSdkLanguageModel {
  const modelName = readRequiredConfigString(config, "model_name");
  const providerName =
    readOptionalConfigString(config, "model_provider") ?? "openai-compatible";
  const apiKeyEnv =
    options.apiKeyEnvOverride ??
    readOptionalConfigString(config, "model_api_key_env") ??
    "MODEL_API_KEY";
  const apiKey = process.env[apiKeyEnv];
  if (!apiKey) {
    throw new Error(`Missing ${apiKeyEnv}.`);
  }

  const baseUrl = resolveModelBaseUrl(config);
  const toolChoice = readModelToolChoice(config);
  const promptCacheEnabled = readModelPromptCacheEnabled(config, providerName);
  const promptCacheTtl = readModelPromptCacheTtl(config);
  const provider = createOpenAICompatible({
    name: providerName,
    baseURL: baseUrl,
    apiKey,
    ...(options.headers ? { headers: options.headers } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {})
  });

  return {
    languageModel: provider.chatModel(modelName),
    providerName,
    modelName,
    baseUrl,
    apiKeyEnv,
    ...(toolChoice !== undefined ? { toolChoice } : {}),
    promptCacheEnabled,
    ...(promptCacheTtl ? { promptCacheTtl } : {}),
    ...optionalProviderOptions(config, providerName)
  };
}

export function readModelPromptCacheEnabled(
  config: GestaltConfig,
  providerName?: string
): boolean {
  return (
    readOptionalConfigBoolean(config, "model_prompt_cache_enabled") ??
    providerName === "openrouter"
  );
}

export function readModelPromptCacheTtl(
  config: GestaltConfig
): "5m" | "1h" | undefined {
  const value = readOptionalConfigString(config, "model_prompt_cache_ttl");
  if (value === undefined || value === "5m" || value === "1h") {
    return value;
  }
  throw new Error('model_prompt_cache_ttl must be "5m" or "1h".');
}

export function readModelToolChoice(
  config: GestaltConfig
): ModelToolChoiceMode | undefined {
  const value = readOptionalConfigString(config, "model_tool_choice");
  if (!value) {
    return undefined;
  }
  if (value === "required" || value === "auto" || value === "none") {
    return value;
  }
  throw new Error(
    `Invalid model_tool_choice "${value}". Expected required, auto, or none.`
  );
}

export function readModelMaxSteps(config: GestaltConfig): number {
  const value = config.flatValues.model_max_steps;
  const numericValue =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : undefined;
  if (numericValue === undefined) {
    return 1000;
  }
  if (!Number.isInteger(numericValue) || numericValue <= 0) {
    throw new Error("model_max_steps must be a positive integer.");
  }
  return numericValue;
}

export function readModelTemperature(config: GestaltConfig): number | undefined {
  const value = config.flatValues.model_temperature;
  const numericValue =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : undefined;
  if (numericValue === undefined) {
    return undefined;
  }
  if (!Number.isFinite(numericValue) || numericValue < 0) {
    throw new Error("model_temperature must be a non-negative number.");
  }
  return numericValue;
}

export function optionalProviderOptions(
  config: GestaltConfig,
  providerName: string
): { providerOptions: ModelProviderOptions } | {} {
  const providerSpecificOptions = readModelProviderOptions(config);
  if (!providerSpecificOptions) {
    return {};
  }

  return {
    providerOptions: {
      [providerName]: providerSpecificOptions
    }
  };
}

export function createModelSessionProviderOptions(
  base: ModelProviderOptions | undefined,
  providerName: string,
  sessionId: string,
  promptCacheEnabled: boolean,
  promptCacheTtl: "5m" | "1h" | undefined
): ModelProviderOptions | undefined {
  if (!promptCacheEnabled) {
    return base;
  }
  const provider = { ...(base?.[providerName] ?? {}) };
  provider.session_id = sessionId;
  provider.cache_control = {
    type: "ephemeral",
    ...(promptCacheTtl === "1h" ? { ttl: "1h" } : {})
  };
  return {
    ...(base ?? {}),
    [providerName]: provider
  };
}

export function snapshotStepRequest(
  event: {
    provider?: string | undefined;
    modelId?: string | undefined;
    stepNumber?: number | undefined;
    messages?: readonly unknown[] | undefined;
    instructions?: unknown;
    tools?: ToolSet | undefined;
    toolChoice?: unknown;
  },
  fallback: {
    providerName: string;
    modelName: string;
    temperature: number;
    sessionId?: string;
    promptCacheEnabled?: boolean;
    prompt?: PromptMetadata;
  }
): ModelRequestSnapshot {
  return {
    provider: event.provider ?? fallback.providerName,
    model: event.modelId ?? fallback.modelName,
    temperature: fallback.temperature,
    stepNumber: event.stepNumber ?? 0,
    messages: snapshotMessages(event.messages ?? [], event.instructions),
    tools: event.tools ? Object.keys(event.tools) : [],
    ...(event.toolChoice !== undefined ? { toolChoice: event.toolChoice } : {}),
    ...(fallback.sessionId ? { sessionId: fallback.sessionId } : {}),
    ...(fallback.promptCacheEnabled !== undefined
      ? { promptCacheEnabled: fallback.promptCacheEnabled }
      : {}),
    ...(fallback.prompt ? { prompt: fallback.prompt } : {})
  };
}

export function snapshotStepResponse(step: {
  stepNumber?: number;
  text?: string;
  finishReason?: string;
  toolCalls?: readonly unknown[];
  toolResults?: readonly unknown[];
  usage?: unknown;
  request?: unknown;
  response?: unknown;
}): ModelResponseSnapshot {
  const requestBody = readUnknownProperty(step.request, "body");
  const responseBody = readUnknownProperty(step.response, "body");
  const cacheUsage = mergeCacheUsage(
    readCacheUsage(step.usage),
    readProviderCacheUsage(responseBody)
  );
  const response: ModelResponseSnapshot = {
    ...(step.text ? { content: step.text } : {}),
    ...(step.finishReason ? { finishReason: step.finishReason } : {}),
    ...(step.stepNumber !== undefined ? { stepNumber: step.stepNumber } : {}),
    toolCalls: snapshotToolCalls(step.toolCalls ?? []),
    toolResults: snapshotToolResults(step.toolResults ?? []),
    ...(step.usage !== undefined ? { usage: step.usage } : {}),
    ...(cacheUsage ? { cacheUsage } : {})
  };
  if (requestBody !== undefined) {
    response.requestBody = requestBody;
  }
  if (responseBody !== undefined) {
    response.responseBody = responseBody;
  }
  return response;
}

function readProviderCacheUsage(
  responseBody: unknown
): ModelCacheUsageSnapshot | undefined {
  const body = parseJsonObject(responseBody);
  const usage = readUnknownProperty(body, "usage");
  const promptDetails = readUnknownProperty(usage, "prompt_tokens_details");
  const readTokens = readOptionalNumber(promptDetails, "cached_tokens");
  const writeTokens = readOptionalNumber(promptDetails, "cache_write_tokens");
  if (readTokens === undefined && writeTokens === undefined) {
    return undefined;
  }
  return {
    readTokens: readTokens ?? 0,
    ...(writeTokens !== undefined ? { writeTokens } : {})
  };
}

function mergeCacheUsage(
  normalized: ModelCacheUsageSnapshot | undefined,
  provider: ModelCacheUsageSnapshot | undefined
): ModelCacheUsageSnapshot | undefined {
  if (!normalized && !provider) {
    return undefined;
  }
  return {
    readTokens: provider?.readTokens ?? normalized?.readTokens ?? 0,
    ...(provider?.writeTokens !== undefined
      ? { writeTokens: provider.writeTokens }
      : normalized?.writeTokens !== undefined
        ? { writeTokens: normalized.writeTokens }
        : {})
  };
}

function readCacheUsage(usage: unknown): ModelCacheUsageSnapshot | undefined {
  const inputDetails = readUnknownProperty(usage, "inputTokenDetails");
  const raw = readUnknownProperty(usage, "raw");
  const promptDetails = readUnknownProperty(raw, "prompt_tokens_details");
  const readTokens =
    readOptionalNumber(inputDetails, "cacheReadTokens") ??
    readOptionalNumber(promptDetails, "cached_tokens");
  const writeTokens =
    readOptionalNumber(inputDetails, "cacheWriteTokens") ??
    readOptionalNumber(promptDetails, "cache_write_tokens");
  if (readTokens === undefined && writeTokens === undefined) {
    return undefined;
  }
  return {
    readTokens: readTokens ?? 0,
    ...(writeTokens !== undefined ? { writeTokens } : {})
  };
}

export interface ActionToolRuntime {
  context: CompiledContext;
  now: () => Date;
  runOptions: ModelRunOptions;
  executedToolResults: ToolExecutionResult[];
}

export function buildActionTools(
  availableTools: readonly ToolDefinition[],
  runtime?: ActionToolRuntime
): ToolSet {
  const tools: ToolSet = {};
  for (const definition of availableTools) {
    tools[definition.name] = createActionTool(definition, runtime);
  }
  return tools;
}

function createActionTool(
  definition: ToolDefinition,
  runtime?: ActionToolRuntime
): ToolSet[string] {
  if (definition.name === "fetch_message") {
    return tool({
      description: renderActionToolDescription(definition.name),
      inputSchema: z
        .object({
          message_id: z
            .string()
            .min(1)
            .describe(toolParameterPrompt(definition.name, "message_id")),
          reason: z
            .string()
            .optional()
            .describe(toolParameterPrompt(definition.name, "reason"))
        })
        .strict(),
      async execute(input) {
        return executeActionToolInput(definition, input, runtime);
      }
    }) as unknown as ToolSet[string];
  }

  if (definition.name === "read_image") {
    return tool({
      description: renderActionToolDescription(definition.name),
      inputSchema: z
        .object({
          file: z
            .string()
            .min(1)
            .describe(toolParameterPrompt(definition.name, "file")),
          reason: z
            .string()
            .optional()
            .describe(toolParameterPrompt(definition.name, "reason"))
        })
        .strict(),
      async execute(input) {
        return executeActionToolInput(definition, input, runtime);
      }
    }) as unknown as ToolSet[string];
  }

  if (definition.name === "send_group_message") {
    return tool({
      description: renderActionToolDescription(definition.name),
      inputSchema: z
        .object({
          text: z
            .string()
            .min(1)
            .describe(toolParameterPrompt(definition.name, "text")),
          reason: z
            .string()
            .optional()
            .describe(toolParameterPrompt(definition.name, "reason"))
        })
        .strict(),
      async execute(input) {
        return executeActionToolInput(definition, input, runtime);
      }
    }) as unknown as ToolSet[string];
  }

  if (definition.name === "send_dm") {
    return tool({
      description: renderActionToolDescription(definition.name),
      inputSchema: z
        .object({
          user_id: z
            .string()
            .min(1)
            .describe(toolParameterPrompt(definition.name, "user_id")),
          text: z
            .string()
            .min(1)
            .describe(toolParameterPrompt(definition.name, "text")),
          reason: z
            .string()
            .optional()
            .describe(toolParameterPrompt(definition.name, "reason"))
        })
        .strict(),
      async execute(input) {
        return executeActionToolInput(definition, input, runtime);
      }
    }) as unknown as ToolSet[string];
  }

  if (definition.name === "send_image") {
    return tool({
      description: renderActionToolDescription(definition.name),
      inputSchema: z
        .object({
          file: z
            .string()
            .min(1)
            .describe(toolParameterPrompt(definition.name, "file")),
          caption: z
            .string()
            .optional()
            .describe(toolParameterPrompt(definition.name, "caption")),
          summary: z
            .string()
            .optional()
            .describe(toolParameterPrompt(definition.name, "summary")),
          reply_to_message_id: z
            .string()
            .optional()
            .describe(toolParameterPrompt(definition.name, "reply_to_message_id")),
          reason: z
            .string()
            .optional()
            .describe(toolParameterPrompt(definition.name, "reason"))
        })
        .strict(),
      async execute(input) {
        return executeActionToolInput(definition, input, runtime);
      }
    }) as unknown as ToolSet[string];
  }

  if (definition.name === "send_sticker") {
    return tool({
      description: renderActionToolDescription(definition.name),
      inputSchema: z
        .object({
          sticker_cq: z
            .string()
            .min(1)
            .describe(toolParameterPrompt(definition.name, "sticker_cq")),
          reply_to_message_id: z
            .string()
            .optional()
            .describe(toolParameterPrompt(definition.name, "reply_to_message_id")),
          reason: z
            .string()
            .optional()
            .describe(toolParameterPrompt(definition.name, "reason"))
        })
        .strict(),
      async execute(input) {
        return executeActionToolInput(definition, input, runtime);
      }
    }) as unknown as ToolSet[string];
  }

  if (definition.name === "poke_user") {
    return tool({
      description: renderActionToolDescription(definition.name),
      inputSchema: z
        .object({
          user_id: z
            .string()
            .min(1)
            .describe(toolParameterPrompt(definition.name, "user_id")),
          reason: z
            .string()
            .optional()
            .describe(toolParameterPrompt(definition.name, "reason"))
        })
        .strict(),
      async execute(input) {
        return executeActionToolInput(definition, input, runtime);
      }
    }) as unknown as ToolSet[string];
  }

  if (definition.name === "recall_own_message") {
    return tool({
      description: renderActionToolDescription(definition.name),
      inputSchema: z
        .object({
          own_message_id: z
            .string()
            .min(1)
            .describe(toolParameterPrompt(definition.name, "own_message_id")),
          reason: z
            .string()
            .optional()
            .describe(toolParameterPrompt(definition.name, "reason"))
        })
        .strict(),
      async execute(input) {
        return executeActionToolInput(definition, input, runtime);
      }
    }) as unknown as ToolSet[string];
  }

  if (definition.name === "react_to_message") {
    return tool({
      description: renderActionToolDescription(definition.name),
      inputSchema: z
        .object({
          message_id: z
            .string()
            .optional()
            .describe(toolParameterPrompt(definition.name, "message_id")),
          emoji_id: z
            .string()
            .min(1)
            .describe(toolParameterPrompt(definition.name, "emoji_id")),
          remove: z
            .boolean()
            .optional()
            .describe(toolParameterPrompt(definition.name, "remove")),
          reason: z
            .string()
            .optional()
            .describe(toolParameterPrompt(definition.name, "reason"))
        })
        .strict(),
      async execute(input) {
        return executeActionToolInput(definition, input, runtime);
      }
    }) as unknown as ToolSet[string];
  }

  return tool({
    description: renderActionToolDescription(definition.name),
    inputSchema: z
      .object({
        reason: z
          .string()
          .optional()
          .describe(toolParameterPrompt(definition.name, "reason"))
      })
      .strict(),
    async execute(input) {
      return executeActionToolInput(definition, input, runtime);
    }
  }) as unknown as ToolSet[string];
}

function toolParameterPrompt(
  toolName: ToolDefinition["name"],
  parameter: string
): string {
  const parameters: Readonly<Record<string, string>> =
    ACTION_TOOL_PROMPTS[toolName].parameters;
  const description = parameters[parameter];
  if (!description) {
    throw new Error(
      `Missing prompt for tool parameter ${toolName}.${parameter}.`
    );
  }
  return description;
}

function collectModelActionResult(
  toolCalls: readonly unknown[],
  executedToolResults: ToolExecutionResult[],
  modelSteps: ModelStepTraceSnapshot[],
  actionTools: readonly ToolDefinition[]
): ModelActionResult {
  const actionToolNames = new Set<string>(
    actionTools.map((candidate) => candidate.name)
  );
  const calledActionTool = toolCalls.some((call) => {
    const name = readUnknownProperty(call, "toolName");
    return typeof name === "string" && actionToolNames.has(name);
  });
  if (calledActionTool && executedToolResults.length === 0) {
    throw new Error(
      "Main agent called tools, but no tool executions were recorded."
    );
  }

  return {
    proposedActions: executedToolResults.map((result) => result.proposal),
    toolResults: executedToolResults,
    modelResponses: modelSteps
      .map((step) => step.response)
      .filter((response): response is ModelResponseSnapshot => Boolean(response)),
    modelSteps
  };
}

async function executeActionToolInput(
  definition: ToolDefinition,
  input: unknown,
  runtime?: ActionToolRuntime
): Promise<Record<string, unknown>> {
  if (!runtime) {
    return {
      toolName: definition.name,
      status: "unavailable",
      reason: "Chat action tools are disabled during terminal dreaming."
    };
  }
  throwIfTurnSteered(runtime.runOptions.signal);
  const connector = runtime.runOptions.connector;
  if (!connector) {
    throw new Error(`Action tool ${definition.name} requires a connector.`);
  }

  const proposal = ActionProposalSchema.parse({
    id: randomUUID(),
    proposedAt: runtime.now().toISOString(),
    ...actionFromToolInput(
      definition.name,
      readInputObject(input, definition.name),
      selectCurrentMessageEvent(runtime.context)
    )
  });
  runtime.runOptions.onToolExecutionStart?.(proposal);
  const [result] = await executeActions({
    connector,
    proposals: [proposal],
    now: runtime.runOptions.now ?? runtime.now,
    ...(runtime.runOptions.toolImplementations
      ? { toolImplementations: runtime.runOptions.toolImplementations }
      : {})
  });
  if (!result) {
    throw new Error(`Action tool ${definition.name} did not return a result.`);
  }

  runtime.executedToolResults.push(result);
  runtime.runOptions.onToolExecutionEnd?.(proposal, result);
  return summarizeToolResultForModel(result);
}

function summarizeToolResultForModel(
  result: ToolExecutionResult
): Record<string, unknown> {
  return {
    toolName: result.proposal.toolName,
    status: result.status,
    ...(result.reason ? { reason: result.reason } : {}),
    ...(result.result?.externalId ? { externalId: result.result.externalId } : {}),
    ...(result.result?.error ? { error: result.result.error } : {}),
    ...(result.result?.data !== undefined
      ? { data: summarizeConnectorData(result.result.data) }
      : {})
  };
}

function actionFromToolInput(
  toolName: string,
  args: Record<string, unknown>,
  currentEvent: MessageReceivedEvent
): Pick<ActionProposal, "toolName" | "reason" | "params"> {
  const reason = typeof args.reason === "string" ? args.reason : undefined;
  const base = {
    ...(reason ? { reason } : {})
  };

  if (toolName === "say_nothing") {
    return {
      ...base,
      toolName: "say_nothing",
      params: {}
    };
  }

  if (toolName === "leave") {
    return {
      ...base,
      toolName: "leave",
      params: {}
    };
  }

  if (toolName === "fetch_message") {
    return {
      ...base,
      toolName: "fetch_message",
      params: {
        messageId: readRequiredStringArgument(args, "message_id", toolName)
      }
    };
  }

  if (toolName === "read_image") {
    return {
      ...base,
      toolName: "read_image",
      params: {
        file: readRequiredStringArgument(args, "file", toolName)
      }
    };
  }

  if (toolName === "send_group_message") {
    return {
      ...base,
      toolName: "send_group_message",
      params: {
        groupId: currentEvent.conversation.id,
        text: readRequiredStringArgument(args, "text", toolName)
      }
    };
  }

  if (toolName === "send_dm") {
    return {
      ...base,
      toolName: "send_dm",
      params: {
        userId: readRequiredStringArgument(args, "user_id", toolName),
        text: readRequiredStringArgument(args, "text", toolName)
      }
    };
  }

  if (toolName === "send_image") {
    return {
      ...base,
      toolName: "send_image",
      params: {
        conversation: currentConversationTarget(currentEvent),
        file: readRequiredStringArgument(args, "file", toolName),
        ...optionalStringArgument(args, "caption"),
        ...optionalStringArgument(args, "summary"),
        ...optionalStringArgument(args, "reply_to_message_id", {
          as: "replyToMessageId"
        })
      }
    };
  }

  if (toolName === "send_sticker") {
    return {
      ...base,
      toolName: "send_sticker",
      params: {
        conversation: currentConversationTarget(currentEvent),
        sticker: readRequiredStringArgument(
          args,
          "sticker_cq",
          toolName
        ),
        ...optionalStringArgument(args, "reply_to_message_id", {
          as: "replyToMessageId"
        })
      }
    };
  }

  if (toolName === "poke_user") {
    return {
      ...base,
      toolName: "poke_user",
      params: {
        userId: readRequiredStringArgument(args, "user_id", toolName),
        conversation: currentConversationTarget(currentEvent)
      }
    };
  }

  if (toolName === "recall_own_message") {
    return {
      ...base,
      toolName: "recall_own_message",
      params: {
        messageId: readRequiredStringArgument(
          args,
          "own_message_id",
          toolName
        )
      }
    };
  }

  if (toolName === "react_to_message") {
    return {
      ...base,
      toolName: "react_to_message",
      params: {
        messageId:
          readOptionalStringArgument(args, "message_id") ??
          currentEvent.message.id,
        emojiId: readRequiredStringArgument(args, "emoji_id", toolName),
        ...(typeof args.remove === "boolean" ? { remove: args.remove } : {})
      }
    };
  }

  throw new Error(`Unsupported action tool: ${toolName}`);
}

function summarizeConnectorData(value: unknown): unknown {
  const json = safeJsonStringify(value);
  if (!json || json.length <= 4000) {
    return value;
  }
  return {
    truncated: true,
    preview: json.slice(0, 4000)
  };
}

function safeJsonStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function currentConversationTarget(event: MessageReceivedEvent): {
  kind: "group" | "private";
  id: string;
} {
  return {
    kind: event.conversation.kind,
    id: event.conversation.id
  };
}

function readInputObject(input: unknown, toolName: string): Record<string, unknown> {
  if (!input || typeof input !== "object") {
    return {};
  }
  if (Array.isArray(input)) {
    throw new Error(`Action tool ${toolName} input must be an object.`);
  }
  return input as Record<string, unknown>;
}

function readRequiredStringArgument(
  args: Record<string, unknown>,
  key: string,
  toolName: string
): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Action tool ${toolName} requires string argument "${key}".`);
  }
  return value;
}

function readOptionalStringArgument(
  args: Record<string, unknown>,
  key: string
): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function optionalStringArgument(
  args: Record<string, unknown>,
  key: string,
  options: { as?: string } = {}
): Record<string, string> {
  const value = readOptionalStringArgument(args, key);
  return value ? { [options.as ?? key]: value } : {};
}

function selectCurrentMessageEvent(context: CompiledContext): MessageReceivedEvent {
  const windowEvents =
    context.window?.events
      .map((record) => record.event)
      .filter(
        (event): event is MessageReceivedEvent => event.type === "MessageReceived"
      ) ?? [];

  if (context.event.type === "MessageReceived") {
    return context.event;
  }

  const fallback = windowEvents.at(-1);
  if (fallback) {
    return fallback;
  }

  throw new Error("AI SDK model requires at least one message event.");
}

function snapshotMessages(
  messages: readonly unknown[],
  instructions?: unknown
): ModelMessageSnapshot[] {
  const snapshots: ModelMessageSnapshot[] = [];
  if (instructions !== undefined) {
    snapshots.push({
      role: "system",
      content: stringifyMessageContent(instructions)
    });
  }
  for (const message of messages) {
    snapshots.push(snapshotMessage(message));
  }
  return snapshots;
}

function snapshotMessage(message: unknown): ModelMessageSnapshot {
  if (message && typeof message === "object") {
    const role = readUnknownProperty(message, "role");
    const content = readUnknownProperty(message, "content");
    return {
      role: typeof role === "string" ? role : "unknown",
      content: stringifyMessageContent(content)
    };
  }
  return {
    role: "unknown",
    content: stringifyMessageContent(message)
  };
}

function snapshotToolCalls(
  toolCalls: readonly unknown[]
): ModelToolCallSnapshot[] {
  return toolCalls.map((toolCall) => readToolCall(toolCall));
}

function snapshotToolResults(
  toolResults: readonly unknown[]
): ModelToolResultSnapshot[] {
  return toolResults.map((toolResult, index) => {
    const id = readUnknownProperty(toolResult, "toolCallId");
    const name = readUnknownProperty(toolResult, "toolName");
    const output = readUnknownProperty(toolResult, "output");
    const error = readUnknownProperty(toolResult, "error");
    return {
      id: typeof id === "string" ? id : `tool-result-${index}`,
      name: typeof name === "string" ? name : "unknown",
      ...(output !== undefined ? { output } : {}),
      ...(error !== undefined ? { error } : {})
    };
  });
}

function readToolCall(toolCall: unknown): ModelToolCallSnapshot {
  const id = readUnknownProperty(toolCall, "toolCallId");
  const name = readUnknownProperty(toolCall, "toolName");
  return {
    id: typeof id === "string" ? id : "unknown-tool-call",
    name: typeof name === "string" ? name : "unknown",
    input: readUnknownProperty(toolCall, "input") ?? {}
  };
}

function stringifyMessageContent(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === null || value === undefined) {
    return "";
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function readUnknownProperty(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return (value as Record<string, unknown>)[key];
}

function readOptionalNumber(value: unknown, key: string): number | undefined {
  const candidate = readUnknownProperty(value, key);
  return typeof candidate === "number" && Number.isFinite(candidate)
    ? candidate
    : undefined;
}

function parseJsonObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    try {
      return parseJsonObject(JSON.parse(value));
    } catch {
      return undefined;
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function forwardAbortSignal(
  source: AbortSignal | undefined,
  target: AbortController
): () => void {
  if (!source) {
    return () => undefined;
  }
  const abort = () => target.abort(source.reason);
  if (source.aborted) {
    abort();
    return () => undefined;
  }
  source.addEventListener("abort", abort, { once: true });
  return () => source.removeEventListener("abort", abort);
}

function resolveModelBaseUrl(config: GestaltConfig): string {
  const baseUrl = readOptionalConfigString(config, "model_base_url");
  if (baseUrl) {
    return baseUrl.replace(/\/+$/, "");
  }

  throw new Error("AI SDK model requires model_base_url.");
}

function readModelProviderOptions(
  config: GestaltConfig
): { [key: string]: ModelJsonValue | undefined } | undefined {
  const routing = readModelRouting(config);
  const thinking = readOptionalConfigString(config, "model_thinking");
  const providerOptions: { [key: string]: ModelJsonValue | undefined } = {};

  if (routing) {
    providerOptions.provider = routing;
  }
  if (thinking) {
    providerOptions.thinking = { type: thinking };
  }

  return Object.keys(providerOptions).length > 0 ? providerOptions : undefined;
}

function readModelRouting(
  config: GestaltConfig
): { [key: string]: ModelJsonValue | undefined } | undefined {
  const order = readOptionalConfigStringList(config, "model_routing_order");
  const allowFallbacks = readOptionalConfigBoolean(
    config,
    "model_routing_allow_fallbacks"
  );
  const sort = readOptionalConfigString(config, "model_routing_sort");

  const routing: { [key: string]: ModelJsonValue | undefined } = {};
  if (order.length > 0) {
    routing.order = order;
  }
  if (allowFallbacks !== undefined) {
    routing.allow_fallbacks = allowFallbacks;
  }
  if (sort) {
    routing.sort = sort;
  }

  return Object.keys(routing).length > 0 ? routing : undefined;
}

function readRequiredConfigString(config: GestaltConfig, key: string): string {
  const value = readOptionalConfigString(config, key);
  if (!value) {
    throw new Error(`Missing required config value "${key}".`);
  }
  return value;
}

function readOptionalConfigString(
  config: GestaltConfig,
  key: string
): string | undefined {
  const value = config.flatValues[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readOptionalConfigStringList(
  config: GestaltConfig,
  key: string
): string[] {
  return (
    readOptionalConfigString(config, key)
      ?.split(",")
      .map((value) => value.trim())
      .filter(Boolean) ?? []
  );
}

function readOptionalConfigBoolean(
  config: GestaltConfig,
  key: string
): boolean | undefined {
  const value = config.flatValues[key];
  return typeof value === "boolean" ? value : undefined;
}
