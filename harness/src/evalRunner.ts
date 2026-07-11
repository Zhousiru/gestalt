import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { generateText, tool } from "ai";
import { z } from "zod";
import {
  type ModelRequestSnapshot,
  type ModelResponseSnapshot
} from "@gestalt/app";
import {
  loadEvalModelConfig,
  type EvalModelConfig
} from "./evalModelConfig";
import {
  runScenarioFixture,
  type HomeFileSnapshot,
  type HomeSnapshot,
  type ReplayRunResult
} from "./replayRunner";
import {
  DEFAULT_EVAL_FIXTURES,
  GENERAL_JUDGE_INSTRUCTIONS,
  GENERAL_JUDGE_TOOL_DESCRIPTION,
  RUBRICS_BY_SCENARIO,
  renderJudgePrompt,
  type EvalRubric
} from "./prompts";

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
    judgeConfigPath: z.string().min(1),
    judgeConfigVersion: z.string().min(1),
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
  traceObservations: unknown[];
  homeChanges: {
    added: HomeFileSnapshot[];
    removed: HomeFileSnapshot[];
    changed: HomeFileSnapshot[];
  };
  artifacts: Record<string, string>;
}

export function getDefaultEvalFixtures(): string[] {
  return [...DEFAULT_EVAL_FIXTURES];
}

export async function runScenarioEval(
  fixturePath: string,
  options: { evalConfigPath?: string } = {}
): Promise<EvalRunResult> {
  const replay = await runScenarioFixture(fixturePath);
  const rubrics = selectRubrics(replay.fixture.id);
  const judgeConfig = await loadEvalModelConfig(options.evalConfigPath);
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
    traceObservations:
      trace?.observations.map((observation) => ({
        type: observation.type,
        name: observation.name,
        input: truncateJson(observation.input, 1000),
        output: truncateJson(observation.output, 1000),
        metadata: truncateJson(observation.metadata, 1000)
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
  config: EvalModelConfig
): Promise<EvalResult> {
  const result = await generateText({
    model: config.languageModel,
    temperature: config.temperature,
    ...(config.providerOptions
      ? { providerOptions: config.providerOptions }
      : {}),
    timeout: {
      totalMs: config.timeoutMs
    },
    instructions: GENERAL_JUDGE_INSTRUCTIONS,
    prompt: renderJudgePrompt(input),
    tools: {
      record_judgment: tool({
        description: GENERAL_JUDGE_TOOL_DESCRIPTION,
        inputSchema: JudgePayloadSchema
      })
    }
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
    judgeConfigPath: config.configPath,
    judgeConfigVersion: config.configVersion,
    judgedAt: new Date().toISOString(),
    artifacts: replay.artifactPaths,
    ...judged
  });
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
      `- Judge config: ${result.judgeConfigPath}`,
      `- Judge config version: ${result.judgeConfigVersion}`,
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
