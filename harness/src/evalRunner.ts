import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { generateText, tool, type LanguageModel } from "ai";
import { z } from "zod";
import {
  createLanguageModelFromConfig,
  type ModelProviderOptions,
  type ModelRequestSnapshot,
  type ModelResponseSnapshot,
  type ModelToolChoiceMode
} from "@gestalt/app";
import {
  runScenarioFixture,
  type HomeFileSnapshot,
  type HomeSnapshot,
  type ReplayRunResult
} from "./replayRunner";

const EvalLabelSchema = z.enum(["pass", "warn", "fail"]);

const JudgePayloadSchema = z
  .object({
    label: EvalLabelSchema,
    score: z.number().min(0).max(1),
    summary: z.string().min(1),
    reasoning: z.string().min(1),
    strengths: z.array(z.string()).default([]),
    concerns: z.array(z.string()).default([]),
    evidence: z.array(z.string()).default([])
  })
  .strict();

export const EvalResultSchema = z
  .object({
    id: z.string().min(1),
    scenarioId: z.string().min(1),
    rubricId: z.string().min(1),
    rubricTitle: z.string().min(1),
    judgeModel: z.string().min(1),
    judgedAt: z.string().min(1),
    label: EvalLabelSchema,
    score: z.number().min(0).max(1),
    summary: z.string().min(1),
    reasoning: z.string().min(1),
    strengths: z.array(z.string()),
    concerns: z.array(z.string()),
    evidence: z.array(z.string()),
    artifacts: z.record(z.string(), z.string())
  })
  .strict();

export type EvalResult = z.infer<typeof EvalResultSchema>;

export interface EvalRunResult {
  replay: ReplayRunResult;
  evalInputs: EvalJudgeInput[];
  results: EvalResult[];
  artifactPaths: {
    inputs: string;
    results: string;
    report: string;
  };
}

interface EvalRubric {
  id: string;
  title: string;
  prompt: string;
  criteria: string[];
}

interface EvalJudgeInput {
  id: string;
  scenarioId: string;
  rubricId: string;
  rubricTitle: string;
  prompt: string;
  criteria: string[];
  evidence: EvalEvidence;
}

interface EvalEvidence {
  scenario: {
    id: string;
    description: string;
  };
  session: Record<string, unknown>;
  modelExchanges: unknown[];
  traceSpans: unknown[];
  homeChanges: {
    added: HomeFileSnapshot[];
    removed: HomeFileSnapshot[];
    changed: HomeFileSnapshot[];
  };
  artifacts: Record<string, string>;
}

interface JudgeConfig {
  languageModel: LanguageModel;
  modelName: string;
  temperature: number;
  providerOptions?: ModelProviderOptions;
  toolChoice?: ModelToolChoiceMode;
}

const DEFAULT_FIXTURES = [
  "harness/fixtures/scenarios/group-chat-loop-steer.json",
  "harness/fixtures/scenarios/group-context-history.json",
  "harness/fixtures/scenarios/model-e2e.json",
  "harness/fixtures/scenarios/multi-step-agent-tools.json",
  "harness/fixtures/scenarios/memory-injection-dreaming.json"
];

const RUBRICS_BY_SCENARIO: Record<string, EvalRubric[]> = {
  "group-chat-loop-steer": [
    {
      id: "group_steer_quality",
      title: "Group Steer Quality",
      prompt:
        "Judge whether the final action reflects the steered group-chat context rather than only the first message.",
      criteria: [
        "The final model response should account for both the original mention and the later steering message.",
        "The bot should avoid duplicate or conflicting replies.",
        "The trace/session should show one coherent completed turn with a clear steer.",
        "The action should be socially plausible for a compact group-chat reply."
      ]
    }
  ],
  "group-context-history": [
    {
      id: "group_context_history_quality",
      title: "Group Context History Quality",
      prompt:
        "Judge whether the compiled group context contains the right history, reply target, self-message labeling, and participant memories.",
      criteria: [
        "The model input should include the current window message and configurable recent history.",
        "The reply target older than the recent-history window should still be expanded into the transcript.",
        "Prior bot messages should be present with a clear self-message label.",
        "Messages outside the configured recent-history count should be absent.",
        "Participant index memories should cover everyone represented in the carried context, not stop at a fixed small cap."
      ]
    }
  ],
  "model-e2e": [
    {
      id: "direct_reply_quality",
      title: "Direct Reply Quality",
      prompt:
        "Judge whether the model made a reasonable visible action for a direct mention.",
      criteria: [
        "The model should treat mentions_bot=true as authoritative.",
        "The selected tool should match the user request.",
        "The reply should be concise and natural.",
        "The output should remain inside an action tool call without extra prose."
      ]
    }
  ],
  "multi-step-agent-tools": [
    {
      id: "multi_step_agent_tool_quality",
      title: "Multi-Step Agent Tool Quality",
      prompt:
        "Judge whether the main agent behaves like a multi-step tool-using agent in one turn.",
      criteria: [
        "The model should execute react_to_message before send_group_message in the same turn.",
        "The model should receive or record the first tool result before continuing to the second tool.",
        "The model should choose leave after the requested visible work is complete.",
        "The exported session should preserve the complete proposed action and tool result sequence.",
        "The trace should make every tool call inspectable under the normal model/tool runtime path.",
        "The final group reply should satisfy the user request without duplicate visible replies."
      ]
    }
  ],
  "memory-injection-dreaming": [
    {
      id: "memory_dreaming_quality",
      title: "Memory Dreaming Quality",
      prompt:
        "Judge whether the memory dreaming pass wrote useful concrete memory through the bash tool.",
      criteria: [
        "The model should inspect relevant memory before writing.",
        "The model should use bash tool calls rather than plain text commands.",
        "Memory updates should be concrete, useful, and not placeholder text.",
        "Self memory and Alice memory should be written to the correct areas.",
        "Commands should stay inside /memories."
      ]
    }
  ]
};

export function getDefaultEvalFixtures(): string[] {
  return [...DEFAULT_FIXTURES];
}

export async function runScenarioEval(
  fixturePath: string
): Promise<EvalRunResult> {
  const replay = await runScenarioFixture(fixturePath);
  const rubrics = selectRubrics(replay.fixture.id);
  const judgeConfig = readJudgeConfig(replay.homeBefore);
  const evalInputs: EvalJudgeInput[] = [];
  const results: EvalResult[] = [];

  for (const rubric of rubrics) {
    const input = buildJudgeInput(replay, rubric);
    evalInputs.push(input);
    results.push(await judgeEval(input, replay, judgeConfig));
  }

  const artifactPaths = await writeEvalArtifacts(replay, evalInputs, results);
  return {
    replay,
    evalInputs,
    results,
    artifactPaths
  };
}

function selectRubrics(scenarioId: string): EvalRubric[] {
  const rubrics = RUBRICS_BY_SCENARIO[scenarioId];
  if (!rubrics?.length) {
    throw new Error(`No eval rubrics registered for scenario ${scenarioId}.`);
  }
  return rubrics;
}

function buildJudgeInput(
  replay: ReplayRunResult,
  rubric: EvalRubric
): EvalJudgeInput {
  return {
    id: randomUUID(),
    scenarioId: replay.fixture.id,
    rubricId: rubric.id,
    rubricTitle: rubric.title,
    prompt: rubric.prompt,
    criteria: rubric.criteria,
    evidence: buildEvidence(replay)
  };
}

function buildEvidence(replay: ReplayRunResult): EvalEvidence {
  const conversation = replay.session.conversations[0];
  const turn = conversation?.turns[0];
  const trace = replay.traces[0];
  const changes = diffHomeSnapshots(replay.homeBefore, replay.homeAfter);

  return {
    scenario: {
      id: replay.fixture.id,
      description: replay.fixture.description
    },
    session: {
      conversation: conversation?.conversation,
      events: conversation?.events.map((event) => ({
        seq: event.seq,
        type: event.event.type,
        text:
          event.event.type === "MessageReceived"
            ? event.event.message.text
            : undefined,
        mentionsBot:
          event.event.type === "MessageReceived"
            ? event.event.message.mentionsBot
            : undefined
      })),
      windows: conversation?.windows,
      turn: turn
        ? {
            status: turn.status,
            fromSeq: turn.fromSeq,
            toSeq: turn.toSeq,
            eventSeqs: turn.eventSeqs,
            steerCount: turn.steerCount,
            phases: turn.phases.map((phase) => phase.phase),
            proposedActions: turn.proposedActions,
            toolResults: turn.toolResults
          }
        : undefined
    },
    modelExchanges: replay.modelExchanges.map((exchange) => ({
      purpose: exchange.purpose,
      request: summarizeModelRequest(exchange.request),
      response: summarizeModelResponse(exchange.response)
    })),
    traceSpans:
      trace?.spans.map((span) => ({
        name: span.name,
        attributes: truncateJson(span.attributes, 3000)
      })) ?? [],
    homeChanges: {
      added: changes.added,
      removed: changes.removed,
      changed: changes.changed
    },
    artifacts: replay.artifactPaths
  };
}

async function judgeEval(
  input: EvalJudgeInput,
  replay: ReplayRunResult,
  config: JudgeConfig
): Promise<EvalResult> {
  const result = await generateText({
    model: config.languageModel,
    temperature: config.temperature,
    ...(config.providerOptions
      ? { providerOptions: config.providerOptions }
      : {}),
    timeout: {
      totalMs: 300_000
    },
    instructions: [
        "You are an LLM judge for an AI persona chatbot runtime.",
        "Judge behavior from the provided replay artifacts and rubric.",
        "This is not a unit test. Most cases are qualitative.",
        "Use concrete evidence from the artifacts.",
        "Call the record_judgment tool exactly once.",
        "Do not answer in normal text."
      ].join("\n"),
    prompt: renderJudgePrompt(input),
    tools: {
      record_judgment: tool({
        description: "Record the final LLM judge result for this replay artifact.",
        inputSchema: JudgePayloadSchema
      })
    },
    toolChoice: {
      type: "tool",
      toolName: "record_judgment"
    } as const
  });

  const toolCall = result.toolCalls.find(
    (call) => call.toolName === "record_judgment"
  );
  if (!toolCall) {
    throw new Error(
      `Eval judge did not call record_judgment. Content preview: ${result.text.slice(
        0,
        300
      )}`
    );
  }

  const judged = JudgePayloadSchema.parse(toolCall.input);
  return EvalResultSchema.parse({
    id: input.id,
    scenarioId: input.scenarioId,
    rubricId: input.rubricId,
    rubricTitle: input.rubricTitle,
    judgeModel: config.modelName,
    judgedAt: new Date().toISOString(),
    artifacts: replay.artifactPaths,
    ...judged
  });
}

function renderJudgePrompt(input: EvalJudgeInput): string {
  return [
    `Scenario: ${input.scenarioId}`,
    `Rubric: ${input.rubricTitle}`,
    "",
    "Task:",
    input.prompt,
    "",
    "Criteria:",
    input.criteria.map((criterion) => `- ${criterion}`).join("\n"),
    "",
    "Evidence JSON:",
    JSON.stringify(input.evidence, null, 2)
  ].join("\n");
}

async function writeEvalArtifacts(
  replay: ReplayRunResult,
  inputs: EvalJudgeInput[],
  results: EvalResult[]
): Promise<EvalRunResult["artifactPaths"]> {
  await mkdir(replay.artifactDir, { recursive: true });

  const paths = {
    inputs: path.join(replay.artifactDir, "eval-inputs.json"),
    results: path.join(replay.artifactDir, "eval-results.json"),
    report: path.join(replay.artifactDir, "eval-report.md")
  };

  await Promise.all([
    writeJson(paths.inputs, inputs),
    writeJson(paths.results, results),
    writeFile(paths.report, renderEvalReport(replay, results), "utf8")
  ]);

  return paths;
}

function renderEvalReport(
  replay: ReplayRunResult,
  results: EvalResult[]
): string {
  return [
    `# Eval Report: ${replay.fixture.id}`,
    "",
    replay.fixture.description,
    "",
    ...results.flatMap((result) => [
      `## ${result.rubricTitle}`,
      "",
      `- Label: ${result.label}`,
      `- Score: ${result.score}`,
      `- Judge model: ${result.judgeModel}`,
      "",
      result.summary,
      "",
      "### Reasoning",
      "",
      result.reasoning,
      "",
      "### Strengths",
      "",
      listOrNone(result.strengths),
      "",
      "### Concerns",
      "",
      listOrNone(result.concerns),
      "",
      "### Evidence",
      "",
      listOrNone(result.evidence),
      ""
    ])
  ].join("\n");
}

function listOrNone(values: string[]): string {
  if (values.length === 0) {
    return "- none";
  }
  return values.map((value) => `- ${value}`).join("\n");
}

function summarizeModelRequest(
  request: ModelRequestSnapshot
): Record<string, unknown> {
  return {
    provider: request.provider,
    model: request.model,
    temperature: request.temperature,
    stepNumber: request.stepNumber,
    tools: request.tools,
    toolChoice: request.toolChoice,
    messages: request.messages.map((message) => ({
      role: message.role,
      content: truncate(message.content, 3000)
    }))
  };
}

function summarizeModelResponse(
  response: ModelResponseSnapshot | undefined
): Record<string, unknown> | undefined {
  if (!response) {
    return undefined;
  }

  return {
    content: truncate(response.content ?? "", 3000),
    finishReason: response.finishReason,
    stepNumber: response.stepNumber,
    toolCalls: response.toolCalls?.map((toolCall) => ({
      name: toolCall.name,
      input: truncateJson(toolCall.input, 1000)
    })),
    toolResults: response.toolResults?.map((toolResult) => ({
      name: toolResult.name,
      output: truncateJson(toolResult.output, 1000),
      error: truncateJson(toolResult.error, 1000)
    }))
  };
}

function diffHomeSnapshots(
  before: HomeSnapshot,
  after: HomeSnapshot
): {
  added: HomeFileSnapshot[];
  removed: HomeFileSnapshot[];
  changed: HomeFileSnapshot[];
} {
  const beforeByPath = new Map(before.files.map((file) => [file.path, file]));
  const afterByPath = new Map(after.files.map((file) => [file.path, file]));

  return {
    added: after.files
      .filter((file) => !beforeByPath.has(file.path))
      .map(compactHomeFile),
    removed: before.files
      .filter((file) => !afterByPath.has(file.path))
      .map(compactHomeFile),
    changed: after.files
      .filter((file) => {
        const beforeFile = beforeByPath.get(file.path);
        return beforeFile !== undefined && beforeFile.sha256 !== file.sha256;
      })
      .map(compactHomeFile)
  };
}

function compactHomeFile(file: HomeFileSnapshot): HomeFileSnapshot {
  return {
    path: file.path,
    bytes: file.bytes,
    sha256: file.sha256,
    ...(file.content ? { content: truncate(file.content, 3000) } : {})
  };
}

function readJudgeConfig(homeBefore: HomeSnapshot): JudgeConfig {
  const configFile = homeBefore.files.find((file) => file.path === "config.toml");
  if (!configFile?.content) {
    throw new Error("Eval judge requires config.toml in home-before snapshot.");
  }

  const values = parseFlatTomlValues(configFile.content);
  const model =
    readOptionalString(values, "eval_model_name") ??
    readRequiredString(values, "model_name");
  const apiKeyEnv =
    readOptionalString(values, "eval_model_api_key_env") ??
    readOptionalString(values, "model_api_key_env") ??
    "MODEL_API_KEY";
  const baseUrl =
    readOptionalString(values, "eval_model_base_url") ??
    readOptionalString(values, "model_base_url");
  const provider =
    readOptionalString(values, "eval_model_provider") ??
    readOptionalString(values, "model_provider");
  const flatValues: Record<string, string | number | boolean> = {
    ...values,
    model_name: model,
    model_api_key_env: apiKeyEnv
  };
  if (baseUrl) {
    flatValues.model_base_url = baseUrl;
  }
  if (provider) {
    flatValues.model_provider = provider;
  }
  const resolved = createLanguageModelFromConfig({
    path: "eval-config.toml",
    raw: configFile.content,
    flatValues
  });

  return {
    languageModel: resolved.languageModel,
    modelName: model,
    temperature: readOptionalNumber(values, "eval_temperature") ?? 0.1,
    ...(resolved.toolChoice !== undefined
      ? { toolChoice: resolved.toolChoice }
      : {}),
    ...(resolved.providerOptions
      ? { providerOptions: resolved.providerOptions }
      : {})
  };
}

function parseFlatTomlValues(raw: string): Record<string, string | number | boolean> {
  const values: Record<string, string | number | boolean> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("[")) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    values[trimmed.slice(0, separator).trim()] = parseScalarValue(
      trimmed.slice(separator + 1).trim()
    );
  }
  return values;
}

function parseScalarValue(value: string): string | number | boolean {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  const quoted = value.match(/^"(.*)"$/);
  if (quoted?.[1] !== undefined) {
    return quoted[1];
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) && value !== "" ? numeric : value;
}

function readRequiredString(
  values: Record<string, string | number | boolean>,
  key: string
): string {
  const value = readOptionalString(values, key);
  if (!value) {
    throw new Error(`Missing required config value "${key}".`);
  }
  return value;
}

function readOptionalString(
  values: Record<string, string | number | boolean>,
  key: string
): string | undefined {
  const value = values[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readOptionalNumber(
  values: Record<string, string | number | boolean>,
  key: string
): number | undefined {
  const value = values[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function truncateJson(value: unknown, maxLength: number): unknown {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    return undefined;
  }
  return serialized.length <= maxLength ? value : truncate(serialized, maxLength);
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
