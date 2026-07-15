import type { GestaltConfig } from "../home/loadConfig";

export type LanguageModelRole = "main" | "sub";

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

export interface ResolvedLanguageModelConfig {
  role: LanguageModelRole;
  providerName: string;
  baseUrl: string;
  modelName: string;
  apiKey?: string;
  apiKeyEnv?: string;
  maxSteps: number;
  temperature: number;
  toolChoice?: ModelToolChoiceMode;
  providerOptions?: ModelProviderOptions;
  promptCacheEnabled: boolean;
  promptCacheTtl?: "5m" | "1h";
}

export interface ResolvedEmbeddingModelConfig {
  id: string;
  providerName: string;
  baseUrl: string;
  modelName: string;
  apiKey?: string;
  apiKeyEnv?: string;
  dimensions?: number;
  routing?: {
    order?: string[];
    allow_fallbacks?: boolean;
  };
}

const defaultLanguageModelProvider = "openai-compatible";
const defaultLanguageModelApiKeyEnv = "MODEL_API_KEY";
const defaultEmbeddingModelApiKeyEnv = "EMBEDDING_MODEL_API_KEY";
const defaultModelMaxSteps = 1000;
const defaultModelTemperature = 1;

export function resolveMainModelConfig(
  config: GestaltConfig
): ResolvedLanguageModelConfig {
  return resolveLanguageModelConfig(config, "main");
}

export function resolveSubModelConfig(
  config: GestaltConfig
): ResolvedLanguageModelConfig {
  return resolveLanguageModelConfig(config, "sub");
}

export function resolveLanguageModelConfig(
  config: GestaltConfig,
  role: LanguageModelRole
): ResolvedLanguageModelConfig {
  const providerName =
    readLanguageString(config, role, "provider") ??
    defaultLanguageModelProvider;
  const modelName = requireLanguageString(config, role, "name");
  const baseUrl = normalizeBaseUrl(
    requireLanguageString(config, role, "base_url")
  );
  const credential = readLanguageCredential(config, role);
  const temperature = readLanguageTemperature(config, role);
  const toolChoice = readLanguageToolChoice(config, role);
  const promptCacheTtl = readLanguagePromptCacheTtl(config, role);
  const providerOptions = readLanguageProviderOptions(
    config,
    role,
    providerName
  );

  return {
    role,
    providerName,
    baseUrl,
    modelName,
    ...credential,
    maxSteps: readLanguageMaxSteps(config, role),
    temperature,
    ...(toolChoice !== undefined ? { toolChoice } : {}),
    ...(providerOptions ? { providerOptions } : {}),
    promptCacheEnabled: readLanguagePromptCacheEnabled(
      config,
      role,
      providerName
    ),
    ...(promptCacheTtl ? { promptCacheTtl } : {})
  };
}

function readLanguageCredential(
  config: GestaltConfig,
  role: LanguageModelRole
): Pick<ResolvedLanguageModelConfig, "apiKey" | "apiKeyEnv"> {
  const rolePrefix = `${role}_model`;
  if (hasCredentialKey(config, rolePrefix)) {
    return readCredentialPair(config, rolePrefix);
  }
  if (role === "sub") {
    return readLanguageCredential(config, "main");
  }
  const legacyApiKeyEnv = readOptionalConfigString(config, "model_api_key_env");
  if (legacyApiKeyEnv) {
    return { apiKeyEnv: legacyApiKeyEnv };
  }
  return { apiKeyEnv: defaultLanguageModelApiKeyEnv };
}

function hasCredentialKey(config: GestaltConfig, prefix: string): boolean {
  return (
    Object.hasOwn(config.flatValues, `${prefix}_api_key`) ||
    Object.hasOwn(config.flatValues, `${prefix}_api_key_env`)
  );
}

function readCredentialPair(
  config: GestaltConfig,
  prefix: string
): Pick<ResolvedLanguageModelConfig, "apiKey" | "apiKeyEnv"> {
  const apiKey = readOptionalConfigString(config, `${prefix}_api_key`);
  const apiKeyEnv = readOptionalConfigString(config, `${prefix}_api_key_env`);
  if (apiKey && apiKeyEnv) {
    throw new Error(
      `${prefix}_api_key and ${prefix}_api_key_env are mutually exclusive.`
    );
  }
  if (apiKey) {
    return { apiKey };
  }
  if (apiKeyEnv) {
    return { apiKeyEnv };
  }
  throw new Error(
    `${prefix}_api_key or ${prefix}_api_key_env must be a non-empty string.`
  );
}

export function resolveEmbeddingModelConfig(
  config: GestaltConfig
): ResolvedEmbeddingModelConfig {
  const id = requireConfigString(config, "embedding_model_id");
  const providerName =
    readOptionalConfigString(config, "embedding_model_provider") ??
    defaultLanguageModelProvider;
  const baseUrl = normalizeBaseUrl(
    requireConfigString(config, "embedding_model_base_url")
  );
  const modelName = requireConfigString(config, "embedding_model_name");
  const apiKey = readOptionalConfigString(config, "embedding_model_api_key");
  const configuredApiKeyEnv = readOptionalConfigString(
    config,
    "embedding_model_api_key_env"
  );
  if (apiKey && configuredApiKeyEnv) {
    throw new Error(
      "embedding_model_api_key and embedding_model_api_key_env are mutually exclusive."
    );
  }
  const apiKeyEnv = apiKey
    ? undefined
    : configuredApiKeyEnv ?? defaultEmbeddingModelApiKeyEnv;
  const dimensions = readOptionalPositiveInteger(
    config,
    "embedding_model_dimensions"
  );
  const routing = readEmbeddingRouting(config);

  return {
    id,
    providerName,
    baseUrl,
    modelName,
    ...(apiKey ? { apiKey } : {}),
    ...(apiKeyEnv ? { apiKeyEnv } : {}),
    ...(dimensions !== undefined ? { dimensions } : {}),
    ...(routing ? { routing } : {})
  };
}

function readEmbeddingRouting(
  config: GestaltConfig
): ResolvedEmbeddingModelConfig["routing"] {
  const order = readOptionalConfigString(
    config,
    "embedding_model_routing_order"
  )
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const allowFallbacks = config.flatValues.embedding_model_routing_allow_fallbacks;
  if (
    allowFallbacks !== undefined &&
    typeof allowFallbacks !== "boolean"
  ) {
    throw new Error(
      "embedding_model_routing_allow_fallbacks must be a boolean."
    );
  }
  if (!order?.length && allowFallbacks === undefined) {
    return undefined;
  }
  return {
    ...(order?.length ? { order } : {}),
    ...(typeof allowFallbacks === "boolean"
      ? { allow_fallbacks: allowFallbacks }
      : {})
  };
}

export function readLanguageTemperature(
  config: GestaltConfig,
  role: LanguageModelRole = "main"
): number {
  const value = readLanguageValue(config, role, "temperature");
  const numericValue = parseConfigNumber(value);
  if (numericValue === undefined) {
    return defaultModelTemperature;
  }
  if (!Number.isFinite(numericValue) || numericValue < 0) {
    throw new Error(
      `${languageConfigKey(role, "temperature")} must be a non-negative number.`
    );
  }
  return numericValue;
}

export function readLanguageMaxSteps(
  config: GestaltConfig,
  role: LanguageModelRole = "main"
): number {
  const value = readLanguageValue(config, role, "max_steps");
  const numericValue = parseConfigNumber(value);
  if (numericValue === undefined) {
    return defaultModelMaxSteps;
  }
  if (!Number.isInteger(numericValue) || numericValue <= 0) {
    throw new Error(
      `${languageConfigKey(role, "max_steps")} must be a positive integer.`
    );
  }
  return numericValue;
}

export function readLanguageToolChoice(
  config: GestaltConfig,
  role: LanguageModelRole = "main"
): ModelToolChoiceMode | undefined {
  const value = readLanguageString(config, role, "tool_choice");
  if (value === undefined) {
    return undefined;
  }
  if (value === "required" || value === "auto" || value === "none") {
    return value;
  }
  throw new Error(
    `Invalid ${languageConfigKey(role, "tool_choice")} "${value}". ` +
      "Expected required, auto, or none."
  );
}

export function readLanguagePromptCacheTtl(
  config: GestaltConfig,
  role: LanguageModelRole = "main"
): "5m" | "1h" | undefined {
  const value = readLanguageString(config, role, "prompt_cache_ttl");
  if (value === undefined || value === "5m" || value === "1h") {
    return value;
  }
  throw new Error(
    `${languageConfigKey(role, "prompt_cache_ttl")} must be "5m" or "1h".`
  );
}

export function readLanguagePromptCacheEnabled(
  config: GestaltConfig,
  role: LanguageModelRole = "main",
  providerName?: string
): boolean {
  const resolvedProviderName =
    providerName ??
    readLanguageString(config, role, "provider") ??
    defaultLanguageModelProvider;
  return (
    readLanguageBoolean(config, role, "prompt_cache_enabled") ??
    resolvedProviderName === "openrouter"
  );
}

function readLanguageProviderOptions(
  config: GestaltConfig,
  role: LanguageModelRole,
  providerName: string
): ModelProviderOptions | undefined {
  const routing = readLanguageRouting(config, role);
  const thinking = readLanguageString(config, role, "thinking");
  const providerOptions: {
    [key: string]: ModelJsonValue | undefined;
  } = {};

  if (routing) {
    providerOptions.provider = routing;
  }
  if (thinking) {
    providerOptions.thinking = { type: thinking };
  }

  return Object.keys(providerOptions).length > 0
    ? { [providerName]: providerOptions }
    : undefined;
}

function readLanguageRouting(
  config: GestaltConfig,
  role: LanguageModelRole
): { [key: string]: ModelJsonValue | undefined } | undefined {
  const order = readLanguageStringList(config, role, "routing_order");
  const allowFallbacks = readLanguageBoolean(
    config,
    role,
    "routing_allow_fallbacks"
  );
  const sort = readLanguageString(config, role, "routing_sort");
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

function requireLanguageString(
  config: GestaltConfig,
  role: LanguageModelRole,
  suffix: string
): string {
  const value = readLanguageString(config, role, suffix);
  if (value) {
    return value;
  }
  const key = languageConfigKey(role, suffix);
  const compatibility =
    role === "main" ? ` (legacy "model_${suffix}" is also accepted)` : "";
  throw new Error(`Missing required config value "${key}"${compatibility}.`);
}

function readLanguageString(
  config: GestaltConfig,
  role: LanguageModelRole,
  suffix: string
): string | undefined {
  const value = readLanguageValue(config, role, suffix);
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${languageConfigKey(role, suffix)} must be a string.`);
  }
  return value.trim() || undefined;
}

function readLanguageStringList(
  config: GestaltConfig,
  role: LanguageModelRole,
  suffix: string
): string[] {
  return (
    readLanguageString(config, role, suffix)
      ?.split(",")
      .map((value) => value.trim())
      .filter(Boolean) ?? []
  );
}

function readLanguageBoolean(
  config: GestaltConfig,
  role: LanguageModelRole,
  suffix: string
): boolean | undefined {
  const value = readLanguageValue(config, role, suffix);
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${languageConfigKey(role, suffix)} must be a boolean.`);
  }
  return value;
}

function readLanguageValue(
  config: GestaltConfig,
  role: LanguageModelRole,
  suffix: string
): GestaltConfig["flatValues"][string] | undefined {
  if (role === "sub") {
    const subKey = languageConfigKey("sub", suffix);
    if (Object.hasOwn(config.flatValues, subKey)) {
      return config.flatValues[subKey];
    }
    return readLanguageValue(config, "main", suffix);
  }

  const mainKey = languageConfigKey("main", suffix);
  if (Object.hasOwn(config.flatValues, mainKey)) {
    return config.flatValues[mainKey];
  }
  return config.flatValues[`model_${suffix}`];
}

function languageConfigKey(role: LanguageModelRole, suffix: string): string {
  return `${role}_model_${suffix}`;
}

function requireConfigString(config: GestaltConfig, key: string): string {
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
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readOptionalPositiveInteger(
  config: GestaltConfig,
  key: string
): number | undefined {
  const numericValue = parseConfigNumber(config.flatValues[key]);
  if (numericValue === undefined) {
    return undefined;
  }
  if (!Number.isInteger(numericValue) || numericValue <= 0) {
    throw new Error(`${key} must be a positive integer.`);
  }
  return numericValue;
}

function parseConfigNumber(value: unknown): number | undefined {
  return typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
      ? Number(value)
      : undefined;
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}
