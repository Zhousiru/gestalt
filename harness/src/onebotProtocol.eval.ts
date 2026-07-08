import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { generateText, tool, type LanguageModel } from "ai";
import { config as loadDotenvFile } from "dotenv";
import {
  createLanguageModelFromConfig,
  type ModelProviderOptions,
  type ModelToolChoiceMode
} from "@gestalt/app";
import { z } from "zod";
import { runOneBotProtocolE2E } from "./onebotProtocolRunner";

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

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
loadLocalEnv(repoRoot);

const result = await runOneBotProtocolE2E();
const input = {
  scenario: result.id,
  rubric: {
    id: "onebot_protocol_e2e_quality",
    title: "OneBot Protocol E2E Quality",
    criteria: [
      "The raw OneBot group event should become a clear canonical group message.",
      "The canonical event should preserve reply, mention, image, and platform emoji information as readable CQ markup.",
      "The model input should expose OneBot CQ markup clearly enough for the model to copy or refer to it.",
      "If the model uses read-only helper tools such as fetch_message or read_image, those calls should map to OneBot/NapCat read APIs and return inspectable tool results before visible side effects.",
      "The connector should send a OneBot send_group_msg API call with CQ string message text and auto_escape=false.",
      "The behavior should remain inside the action/tool architecture instead of bypassing the runtime."
    ]
  },
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
        content: truncate(message.content ?? "", 4000)
      }))
    })),
    modelResponses: result.modelResponses,
    artifacts: result.artifactPaths
  }
};
const judged = await judge(input);
const paths = await writeEvalArtifacts(result.artifactPaths.report, input, judged);

console.log(
  JSON.stringify(
    {
      ok: judged.label !== "fail",
      scenario: result.id,
      label: judged.label,
      score: judged.score,
      summary: judged.summary,
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

async function judge(input: unknown): Promise<JudgeResult> {
  const config = await readJudgeConfig();
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
      "You are an LLM judge for a OneBot protocol integration in an AI persona chatbot runtime.",
      "Judge only from the provided artifacts.",
      "Call the record_judgment tool exactly once.",
      "Do not answer in normal text."
    ].join("\n"),
    prompt: JSON.stringify(input, null, 2),
    tools: {
      record_judgment: tool({
        description: "Record the final OneBot protocol evaluation judgment.",
        inputSchema: JudgeResultSchema
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
      `OneBot eval judge did not call record_judgment. Content preview: ${result.text.slice(
        0,
        300
      )}`
    );
  }
  return JudgeResultSchema.parse(toolCall.input);
}

async function readJudgeConfig(): Promise<{
  languageModel: LanguageModel;
  modelName: string;
  temperature: number;
  providerOptions?: ModelProviderOptions;
  toolChoice?: ModelToolChoiceMode;
}> {
  const configPath = path.join(
    repoRoot,
    "harness/fixtures/homes/simple-group-test/config.toml"
  );
  const values = parseFlatTomlValues(await readFile(configPath, "utf8"));
  const model = readRequiredString(values, "model_name");
  const apiKeyEnv = readOptionalString(values, "model_api_key_env") ?? "MODEL_API_KEY";
  const resolved = createLanguageModelFromConfig({
    path: configPath,
    raw: await readFile(configPath, "utf8"),
    flatValues: {
      ...values,
      model_name: model,
      model_api_key_env: apiKeyEnv
    }
  });
  return {
    languageModel: resolved.languageModel,
    modelName: model,
    temperature: 0.1,
    ...(resolved.toolChoice !== undefined
      ? { toolChoice: resolved.toolChoice }
      : {}),
    ...(resolved.providerOptions
      ? { providerOptions: resolved.providerOptions }
      : {})
  };
}

async function writeEvalArtifacts(
  reportPath: string,
  input: unknown,
  result: JudgeResult
): Promise<{ evalInputs: string; evalResults: string; evalReport: string }> {
  const artifactDir = path.dirname(reportPath);
  await mkdir(artifactDir, { recursive: true });
  const paths = {
    evalInputs: path.join(artifactDir, "eval-inputs.json"),
    evalResults: path.join(artifactDir, "eval-results.json"),
    evalReport: path.join(artifactDir, "eval-report.md")
  };
  await Promise.all([
    writeJson(paths.evalInputs, input),
    writeJson(paths.evalResults, result),
    writeFile(
      paths.evalReport,
      [
        "# OneBot Protocol Eval",
        "",
        `- Label: ${result.label}`,
        `- Score: ${result.score}`,
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

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}

function loadLocalEnv(root: string): void {
  for (const fileName of [".env", ".env.local"]) {
    loadDotenvFile({
      path: path.join(root, fileName),
      override: false,
      quiet: true
    });
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
