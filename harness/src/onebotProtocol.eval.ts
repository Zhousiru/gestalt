import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { generateText, tool } from "ai";
import { z } from "zod";
import {
  loadEvalModelConfig,
  type EvalModelConfig
} from "./evalModelConfig";
import { runOneBotProtocolE2E } from "./onebotProtocolRunner";
import {
  ONEBOT_JUDGE_INSTRUCTIONS,
  ONEBOT_JUDGE_TOOL_DESCRIPTION,
  ONEBOT_RUBRIC
} from "./prompts";
import { writeArtifactJson } from "./artifactBinary";

interface JudgeResult {
  label: "pass" | "warn" | "fail";
  score: number;
  summary: string;
  reasoning: string;
  evidence: string[];
}

const JudgeResultSchema = z
  .object({
    label: z.enum(["pass", "warn", "fail"]),
    score: z.number().min(0).max(1),
    summary: z.string().min(1),
    reasoning: z.string().min(1),
    evidence: z.array(z.string()).default([])
  })
  .strict();

const result = await runOneBotProtocolE2E();
const input = {
  scenario: result.id,
  rubric: ONEBOT_RUBRIC,
  evidence: {
    canonicalEvent: result.event,
    session: result.session,
    onebotApiCalls: result.onebotApiCalls,
    modelRequests: result.modelRequests.map((request) => ({
      model: request.model,
      tools: request.tools,
      toolChoice: request.toolChoice,
      messages: request.messages.map((message) => ({
        role: message.role,
        content: truncate(modelContentText(message.content), 4000)
      }))
    })),
    modelResponses: result.modelResponses,
    artifacts: result.artifactPaths
  }
};

function modelContentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  return JSON.stringify(value) ?? String(value);
}
const judgeConfig = await loadEvalModelConfig();
const judged = await judge(input, judgeConfig);
const paths = await writeEvalArtifacts(
  result.artifactPaths.report,
  input,
  judged,
  judgeConfig
);

console.log(
  JSON.stringify(
    {
      ok: judged.label !== "fail",
      scenario: result.id,
      label: judged.label,
      score: judged.score,
      summary: judged.summary,
      judgeModel: judgeConfig.modelName,
      judgeConfig: judgeConfig.configPath,
      judgeConfigVersion: judgeConfig.configVersion,
      artifacts: {
        ...result.artifactPaths,
        ...paths
      }
    },
    null,
    2
  )
);

if (judged.label === "fail") {
  process.exitCode = 1;
}

async function judge(
  input: unknown,
  config: EvalModelConfig
): Promise<JudgeResult> {
  const result = await generateText({
    model: config.languageModel,
    temperature: config.temperature,
    ...(config.providerOptions
      ? { providerOptions: config.providerOptions }
      : {}),
    timeout: {
      totalMs: config.timeoutMs
    },
    instructions: ONEBOT_JUDGE_INSTRUCTIONS,
    prompt: JSON.stringify(input, null, 2),
    tools: {
      record_judgment: tool({
        description: ONEBOT_JUDGE_TOOL_DESCRIPTION,
        inputSchema: JudgeResultSchema
      })
    }
  });

  const toolCall = result.toolCalls.find(
    (call) => call.toolName === "record_judgment"
  );
  if (!toolCall) {
    throw new Error(
      `OneBot eval judge did not call record_judgment. Content preview: ${result.text.slice(
        0,
        300
      )}`
    );
  }
  return JudgeResultSchema.parse(toolCall.input);
}

async function writeEvalArtifacts(
  reportPath: string,
  input: unknown,
  result: JudgeResult,
  config: EvalModelConfig
): Promise<{ evalInputs: string; evalResults: string; evalReport: string }> {
  const artifactDir = path.dirname(reportPath);
  await mkdir(artifactDir, { recursive: true });
  const paths = {
    evalInputs: path.join(artifactDir, "eval-inputs.json"),
    evalResults: path.join(artifactDir, "eval-results.json"),
    evalReport: path.join(artifactDir, "eval-report.md")
  };
  await Promise.all([
    writeArtifactJson(paths.evalInputs, input),
    writeArtifactJson(paths.evalResults, {
      judge: summarizeJudgeConfig(config),
      result
    }),
    writeFile(
      paths.evalReport,
      [
        "# OneBot Protocol Eval",
        "",
        `- Label: ${result.label}`,
        `- Score: ${result.score}`,
        `- Judge model: ${config.modelName}`,
        `- Judge config: ${config.configPath}`,
        `- Judge config version: ${config.configVersion}`,
        "",
        result.summary,
        "",
        "## Reasoning",
        "",
        result.reasoning,
        "",
        "## Evidence",
        "",
        result.evidence.map((item) => `- ${item}`).join("\n") || "- none",
        ""
      ].join("\n"),
      "utf8"
    )
  ]);
  return paths;
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}

function summarizeJudgeConfig(config: EvalModelConfig): Record<string, unknown> {
  return {
    model: config.modelName,
    configPath: config.configPath,
    configVersion: config.configVersion,
    temperature: config.temperature,
    timeoutMs: config.timeoutMs,
    ...(config.thinking ? { thinking: config.thinking } : {})
  };
}
