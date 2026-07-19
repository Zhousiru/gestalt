import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { embed as createEmbedding } from "ai";
import type { GestaltConfig } from "../home/loadConfig";
import {
  resolveEmbeddingModelConfig,
  type ResolvedEmbeddingModelConfig
} from "./modelConfig";

export interface EmbeddingClient {
  readonly providerName: string;
  readonly modelName: string;
  readonly dimensions?: number;
  embed(text: string, options?: EmbedTextOptions): Promise<number[]>;
}

export type EmbeddingInputType = "document" | "query";

export interface EmbedTextOptions {
  signal?: AbortSignal;
  inputType?: EmbeddingInputType;
  queryInstruction?: string;
}

export interface EmbeddingRequestSnapshot {
  provider: string;
  model: string;
  inputType: EmbeddingInputType;
  inputLength: number;
  requestedDimensions?: number;
}

export interface EmbeddingResponseSnapshot {
  provider: string;
  model: string;
  dimensions: number;
}

export interface CreateEmbeddingClientFromConfigOptions {
  apiKeyEnvOverride?: string;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
  maxRetries?: number;
  onRequest?: (request: EmbeddingRequestSnapshot) => void;
  onResponse?: (response: EmbeddingResponseSnapshot) => void;
}

export function createEmbeddingClientFromConfig(
  config: GestaltConfig,
  options: CreateEmbeddingClientFromConfigOptions = {}
): EmbeddingClient {
  return createEmbeddingClient(
    resolveEmbeddingModelConfig(config),
    options
  );
}

export function createEmbeddingClient(
  config: ResolvedEmbeddingModelConfig,
  options: CreateEmbeddingClientFromConfigOptions = {}
): EmbeddingClient {
  const apiKeyEnv = options.apiKeyEnvOverride ?? config.apiKeyEnv;
  const apiKey = options.apiKeyEnvOverride
    ? process.env[options.apiKeyEnvOverride]
    : config.apiKey ?? (apiKeyEnv ? process.env[apiKeyEnv] : undefined);
  if (!apiKey) {
    throw new Error(
      apiKeyEnv
        ? `Missing ${apiKeyEnv}.`
        : "Missing embedding model API key."
    );
  }

  const provider = createOpenAICompatible({
    name: config.providerName,
    baseURL: config.baseUrl,
    apiKey,
    ...(options.headers ? { headers: options.headers } : {}),
    ...(options.fetch || config.routing
      ? {
          fetch: createRoutedEmbeddingFetch(
            options.fetch ?? globalThis.fetch,
            config.routing
          )
        }
      : {})
  });
  const model = provider.embeddingModel(config.modelName);
  const requestOptions = {
    ...(config.dimensions ? { dimensions: config.dimensions } : {})
  };
  const providerOptions = Object.keys(requestOptions).length > 0
    ? { openaiCompatible: requestOptions }
    : undefined;

  return {
    providerName: config.providerName,
    modelName: config.modelName,
    ...(config.dimensions ? { dimensions: config.dimensions } : {}),

    async embed(text, embedOptions = {}) {
      if (!text.trim()) {
        throw new Error("Embedding input must not be empty.");
      }
      const inputType = embedOptions.inputType ?? "document";
      const requestText = inputType === "query"
        ? `Instruct: ${embedOptions.queryInstruction ?? "Retrieve text matching the user's intended reaction"}\nQuery: ${text}`
        : text;
      options.onRequest?.({
        provider: config.providerName,
        model: config.modelName,
        inputType,
        inputLength: requestText.length,
        ...(config.dimensions
          ? { requestedDimensions: config.dimensions }
          : {})
      });

      const result = await createEmbedding({
        model,
        value: requestText,
        ...(providerOptions ? { providerOptions } : {}),
        ...(options.maxRetries !== undefined
          ? { maxRetries: options.maxRetries }
          : {}),
        ...(embedOptions.signal ? { abortSignal: embedOptions.signal } : {})
      });

      if (
        config.dimensions !== undefined &&
        result.embedding.length !== config.dimensions
      ) {
        throw new Error(
          `Embedding model ${config.modelName} returned ` +
            `${result.embedding.length} dimensions; expected ${config.dimensions}.`
        );
      }
      options.onResponse?.({
        provider: config.providerName,
        model: config.modelName,
        dimensions: result.embedding.length
      });
      return result.embedding;
    }
  };
}

function createRoutedEmbeddingFetch(
  fetchImplementation: typeof fetch,
  routing: ResolvedEmbeddingModelConfig["routing"]
): typeof fetch {
  if (!routing) {
    return fetchImplementation;
  }
  return async (input, init) => {
    if (typeof init?.body !== "string") {
      return fetchImplementation(input, init);
    }
    const body = JSON.parse(init.body) as Record<string, unknown>;
    return fetchImplementation(input, {
      ...init,
      body: JSON.stringify({ ...body, provider: routing })
    });
  };
}
