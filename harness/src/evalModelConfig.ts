import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { LanguageModel } from "ai";
import { config as loadDotenvFile } from "dotenv";
import {
  createLanguageModelFromConfig,
  type ModelProviderOptions
} from "@gestalt/app";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const defaultEvalConfigPath = path.join(repoRoot, "harness/config/eval.toml");

export interface EvalModelConfig {
  languageModel: LanguageModel;
  modelName: string;
  temperature: number;
  timeoutMs: number;
  configPath: string;
  configVersion: string;
  thinking?: string;
  providerOptions?: ModelProviderOptions;
}

export interface EvalCliArguments {
  fixturePaths: string[];
  evalConfigPath?: string;
}

export function parseEvalCliArguments(args: string[]): EvalCliArguments {
  const fixturePaths: string[] = [];
  let evalConfigPath: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--eval-config") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--eval-config requires a file path.");
      }
      evalConfigPath = value;
      index += 1;
      continue;
    }
    if (argument?.startsWith("--eval-config=")) {
      const value = argument.slice("--eval-config=".length);
      if (!value) {
        throw new Error("--eval-config requires a file path.");
      }
      evalConfigPath = value;
      continue;
    }
    if (argument?.startsWith("--")) {
      throw new Error(`Unknown eval option: ${argument}`);
    }
    if (argument) {
      fixturePaths.push(argument);
    }
  }

  return {
    fixturePaths,
    ...(evalConfigPath ? { evalConfigPath } : {})
  };
}

export async function loadEvalModelConfig(
  explicitPath?: string
): Promise<EvalModelConfig> {
  loadLocalEnv();
  const cliPath = parseEvalCliArguments(process.argv.slice(2)).evalConfigPath;
  const configuredPath =
    explicitPath ?? cliPath ?? process.env.GESTALT_EVAL_CONFIG;
  const configPath = path.resolve(repoRoot, configuredPath ?? defaultEvalConfigPath);
  const raw = await readFile(configPath, "utf8").catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read eval config ${configPath}: ${message}`);
  });
  const values = parseFlatTomlValues(raw);
  const modelName = readRequiredString(values, "model_name");
  const runtimeValues = mapEvalModelValues(values);
  const resolved = createLanguageModelFromConfig({
    path: configPath,
    raw,
    flatValues: runtimeValues
  });
  const temperature = readOptionalNumber(values, "temperature") ?? 0.1;
  const timeoutMs = readOptionalNumber(values, "timeout_ms") ?? 300_000;
  const thinking = readOptionalString(values, "model_thinking");
  if (temperature < 0) {
    throw new Error("Eval temperature must be non-negative.");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Eval timeout_ms must be a positive number.");
  }

  return {
    languageModel: resolved.languageModel,
    modelName,
    temperature,
    timeoutMs,
    configPath,
    configVersion: createHash("sha256").update(raw).digest("hex").slice(0, 16),
    ...(thinking ? { thinking } : {}),
    ...(resolved.providerOptions
      ? { providerOptions: resolved.providerOptions }
      : {})
  };
}

function mapEvalModelValues(
  values: Record<string, string | number | boolean>
): Record<string, string | number | boolean> {
  const runtimeValues = { ...values };
  for (const suffix of [
    "provider",
    "base_url",
    "name",
    "api_key_env",
    "api_key",
    "routing_order",
    "routing_allow_fallbacks",
    "routing_sort",
    "thinking",
    "tool_choice"
  ]) {
    const value = values[`model_${suffix}`];
    if (value !== undefined) {
      runtimeValues[`main_model_${suffix}`] = value;
    }
  }
  runtimeValues.main_model_temperature =
    readOptionalNumber(values, "temperature") ?? 0.1;
  return runtimeValues;
}

function loadLocalEnv(): void {
  for (const fileName of [".env", ".env.local"]) {
    loadDotenvFile({
      path: path.join(repoRoot, fileName),
      override: false,
      quiet: true
    });
  }
}

function parseFlatTomlValues(
  raw: string
): Record<string, string | number | boolean> {
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
    throw new Error(`Missing required eval config value "${key}".`);
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
