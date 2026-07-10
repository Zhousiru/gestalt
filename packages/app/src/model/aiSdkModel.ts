import { randomUUID } from "node:crypto";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
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
        instructions = buildSessionInstructions(context);
        messages.push({ role: "user", content: buildWindowPrompt(context, false) });
        initialized = true;
      } else {
        messages.push({ role: "user", content: buildWindowPrompt(context, true) });
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
          if (!attemptContext || !instructions) {
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
            stopWhen: stepCountIs(maxSteps),
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
                promptCacheEnabled: options.promptCacheEnabled ?? false
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
      messages.push({ role: "user", content: buildWindowPrompt(context, true) });
      attemptController?.abort(new TurnSteeredError());
      return true;
    },

    continuation(): ModelSessionContinuation | undefined {
      if (!initialized || running || !instructions) {
        return undefined;
      }
      return {
        instructions,
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
      : {})
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

function buildActionInstructions(tools: ToolDefinition[]): string {
  const hasLeaveTool = tools.some((candidate) => candidate.name === "leave");
  const instructions = [
    "You are the main multi-step agent for a group-chat persona runtime.",
    "You may call tools as needed across multiple steps, like a coding agent.",
    "Call at most one tool in a single model step, including say_nothing.",
    "After each tool result, reassess the conversation and decide whether to call another tool, call say_nothing, or stay active.",
    "Tool calls are the only way to create visible side effects or lifecycle changes.",
    "The bash and finish_dreaming tools are reserved for an explicitly announced terminal dreaming phase. Never call them during the normal chat-action phase.",
    "Conversation messages may contain OneBot-style CQ markup such as [CQ:at,qq=...], [CQ:reply,id=...], [CQ:image,file=...,url=...], [CQ:face,id=...], and [CQ:mface,emoji_package_id=...,emoji_id=...,key=...].",
    "When repeating or preserving platform-specific parts of a message, copy the CQ markup exactly in the relevant tool input.",
    "When visibly replying to the current message, start send_group_message text with [CQ:reply,id=<message_id>] using the current transcript message_id value.",
    "For example, if the current transcript metadata says message_id=321, reply text should start with [CQ:reply,id=321].",
    "Use send_image only with image file ids, URLs, file URIs, or base64:// payloads that appear in context or are explicitly provided.",
    "Use send_sticker only when exact [CQ:face,...] or [CQ:mface,...] markup is available to copy.",
    "Use fetch_message before answering when the current message has reply_to=... and the corresponding quoted message is not already visible as context=reply_target.",
    "Use read_image before describing or interpreting image contents when the transcript only has [CQ:image,...] metadata.",
    "Use react_to_message for lightweight acknowledgement when a reaction is better than a full message.",
    "Use poke_user only as an explicitly invited or clearly playful QQ poke/nudge, and avoid repeated pokes.",
    "Use recall_own_message only for a message sent by this bot, such as a recent tool result externalId or sender_role=self message id.",
    "Use send_dm only when private follow-up was clearly invited or a public reply would expose private context.",
    "Do not invent image file names, URLs, sticker ids, face ids, mface keys, emoji ids, or user ids. Reuse identifiers only when they appear in the transcript or the user explicitly provides them.",
    "mentions_bot=true is an authoritative normalized signal that the bot was addressed.",
    "Window reasons keyword and reply_to_bot are also normalized trigger signals that the bot was invoked.",
    "Transcript records may be labeled context=history, context=current_window, and context=reply_target.",
    "Use context=current_window as the current decision input. Use history and reply_target records only to understand continuity.",
    "Records labeled sender_role=self are messages previously sent by this bot.",
    "If any current-window group message has mentions_bot=true, or the window reason is keyword or reply_to_bot, usually choose send_group_message.",
    "For activity windows, usually observe with say_nothing unless someone clearly asks for the bot.",
    "For icebreaker windows, a brief warm reply is appropriate when the latest message invites renewed conversation or discusses the icebreaker trigger.",
    "Do not infer from persona role name alone whether the bot was addressed; use normalized trigger signals instead.",
    "Use say_nothing when this turn should intentionally produce no visible action while leaving loop shutdown to exit triggers or later context.",
    "Keep visible messages short and natural.",
    "Do not call the same visible side-effect tool repeatedly unless the user explicitly requested multiple actions."
  ];

  if (hasLeaveTool) {
    instructions.splice(
      5,
      0,
      "When the current active loop is complete, call leave as the final tool before stopping.",
      "Only stop with a brief private final note without leave when the active loop should remain open for later window steering. That final note is recorded for trace only and is not sent to chat."
    );
    instructions.splice(
      instructions.length - 2,
      0,
      "Use leave when you explicitly want the current active loop to end and future messages should return to pre-trigger handling.",
      "Do not call say_nothing and leave for the same decision.",
      "After calling leave, do not call more tools in this turn.",
      "Do not use leave when a visible reply is still needed."
    );
  } else {
    instructions.splice(
      5,
      0,
      "The active loop is configured to stay open for later window steering, so do not try to end it with a lifecycle tool.",
      "When no visible action is needed, use say_nothing or stop with a brief private final note; that final note is recorded for trace only and is not sent to chat."
    );
  }

  return instructions.join("\n");
}

function buildSessionInstructions(context: CompiledContext): string {
  const persona = context.persona.fragments
    .map((fragment) => `# ${fragment.name}\n${fragment.content}`)
    .join("\n\n");
  const memories = context.memories
    .map(
      (memory) =>
        `# ${memory.relativePath}\n${memory.content.trim() || "(empty)"}`
    )
    .join("\n\n");
  return [
    buildActionInstructions(context.tools),
    "",
    "Persona:",
    persona || "(empty)",
    "",
    "Relevant memory:",
    memories || "(none)"
  ].join("\n");
}

function buildWindowPrompt(context: CompiledContext, isSteer: boolean): string {
  const currentEvent = selectCurrentMessageEvent(context);
  return [
    isSteer
      ? "New conversation window received while this agent session is active."
      : "Initial conversation window for this agent session.",
    "Treat this as new user-side context appended after all earlier messages and tool results.",
    "",
    "Conversation transcript:",
    context.transcript,
    "",
    "Decision target:",
    "The latest message in this window is the current message to answer or ignore.",
    describeCurrentMessage(currentEvent),
    "",
    "Current conversation:",
    `${currentEvent.conversation.kind}:${currentEvent.conversation.id}`
  ].join("\n");
}

function describeCurrentMessage(event: MessageReceivedEvent): string {
  return [
    `- latest_seq_message_id: ${event.message.id}`,
    `- latest_sender: ${event.sender.displayName ?? event.sender.id} (${event.sender.id})`,
    `- latest_mentions_bot: ${event.message.mentionsBot}`,
    `- latest_text: ${event.message.text}`
  ].join("\n");
}

function renderToolDescription(definition: ToolDefinition): string {
  return [
    definition.purpose,
    `Useful when: ${definition.whenUseful.join("; ")}`,
    `Avoid when: ${definition.avoidWhen.join("; ")}`
  ].join("\n");
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
      description: renderToolDescription(definition),
      inputSchema: z
        .object({
          message_id: z
            .string()
            .min(1)
            .describe("Message id to fetch, copied from reply_to metadata."),
          reason: z
            .string()
            .optional()
            .describe("Brief reason for fetching this message.")
        })
        .strict(),
      async execute(input) {
        return executeActionToolInput(definition, input, runtime);
      }
    }) as unknown as ToolSet[string];
  }

  if (definition.name === "read_image") {
    return tool({
      description: renderToolDescription(definition),
      inputSchema: z
        .object({
          file: z
            .string()
            .min(1)
            .describe(
              "Image file id copied from [CQ:image,file=...] in the transcript."
            ),
          reason: z
            .string()
            .optional()
            .describe("Brief reason for reading this image.")
        })
        .strict(),
      async execute(input) {
        return executeActionToolInput(definition, input, runtime);
      }
    }) as unknown as ToolSet[string];
  }

  if (definition.name === "send_group_message") {
    return tool({
      description: renderToolDescription(definition),
      inputSchema: z
        .object({
          text: z
            .string()
            .min(1)
            .describe(
              "Message text to send. May include CQ markup such as [CQ:reply,id=321] or [CQ:face,id=14]."
            ),
          reason: z
            .string()
            .optional()
            .describe("Brief reason for choosing this action.")
        })
        .strict(),
      async execute(input) {
        return executeActionToolInput(definition, input, runtime);
      }
    }) as unknown as ToolSet[string];
  }

  if (definition.name === "send_dm") {
    return tool({
      description: renderToolDescription(definition),
      inputSchema: z
        .object({
          user_id: z
            .string()
            .min(1)
            .describe("Target user id copied from transcript metadata."),
          text: z
            .string()
            .min(1)
            .describe("Private message text. May include CQ markup if needed."),
          reason: z
            .string()
            .optional()
            .describe("Brief reason for choosing this action.")
        })
        .strict(),
      async execute(input) {
        return executeActionToolInput(definition, input, runtime);
      }
    }) as unknown as ToolSet[string];
  }

  if (definition.name === "send_image") {
    return tool({
      description: renderToolDescription(definition),
      inputSchema: z
        .object({
          file: z
            .string()
            .min(1)
            .describe(
              "Image file id, URL, file URI, or base64:// payload copied from context or explicitly provided."
            ),
          caption: z
            .string()
            .optional()
            .describe("Optional short caption to place before the image."),
          summary: z
            .string()
            .optional()
            .describe("Optional image summary for platform metadata."),
          reply_to_message_id: z
            .string()
            .optional()
            .describe("Optional message id to quote before the image."),
          reason: z
            .string()
            .optional()
            .describe("Brief reason for choosing this action.")
        })
        .strict(),
      async execute(input) {
        return executeActionToolInput(definition, input, runtime);
      }
    }) as unknown as ToolSet[string];
  }

  if (definition.name === "send_sticker") {
    return tool({
      description: renderToolDescription(definition),
      inputSchema: z
        .object({
          sticker_cq: z
            .string()
            .min(1)
            .describe(
              "Exact [CQ:face,...] or [CQ:mface,...] markup copied from the transcript or user request."
            ),
          reply_to_message_id: z
            .string()
            .optional()
            .describe("Optional message id to quote before the sticker."),
          reason: z
            .string()
            .optional()
            .describe("Brief reason for choosing this action.")
        })
        .strict(),
      async execute(input) {
        return executeActionToolInput(definition, input, runtime);
      }
    }) as unknown as ToolSet[string];
  }

  if (definition.name === "poke_user") {
    return tool({
      description: renderToolDescription(definition),
      inputSchema: z
        .object({
          user_id: z
            .string()
            .min(1)
            .describe("Target user id copied from transcript metadata."),
          reason: z
            .string()
            .optional()
            .describe("Brief reason for choosing this action.")
        })
        .strict(),
      async execute(input) {
        return executeActionToolInput(definition, input, runtime);
      }
    }) as unknown as ToolSet[string];
  }

  if (definition.name === "recall_own_message") {
    return tool({
      description: renderToolDescription(definition),
      inputSchema: z
        .object({
          own_message_id: z
            .string()
            .min(1)
            .describe(
              "Message id for a message sent by this bot, copied from a tool result externalId or sender_role=self transcript record."
            ),
          reason: z
            .string()
            .optional()
            .describe("Brief reason for recalling this bot message.")
        })
        .strict(),
      async execute(input) {
        return executeActionToolInput(definition, input, runtime);
      }
    }) as unknown as ToolSet[string];
  }

  if (definition.name === "react_to_message") {
    return tool({
      description: renderToolDescription(definition),
      inputSchema: z
        .object({
          message_id: z
            .string()
            .optional()
            .describe(
              "Target message id. Defaults to the latest transcript message when omitted."
            ),
          emoji_id: z
            .string()
            .min(1)
            .describe("Platform emoji id copied from context or configuration."),
          remove: z
            .boolean()
            .optional()
            .describe("Set true to remove the reaction instead of adding it."),
          reason: z
            .string()
            .optional()
            .describe("Brief reason for choosing this action.")
        })
        .strict(),
      async execute(input) {
        return executeActionToolInput(definition, input, runtime);
      }
    }) as unknown as ToolSet[string];
  }

  return tool({
    description: renderToolDescription(definition),
    inputSchema: z
      .object({
        reason: z
          .string()
          .optional()
          .describe("Brief reason for choosing this action.")
      })
      .strict(),
    async execute(input) {
      return executeActionToolInput(definition, input, runtime);
    }
  }) as unknown as ToolSet[string];
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
