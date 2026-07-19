import { generateText, Output } from "ai";
import type { GestaltConfig } from "../home/loadConfig";
import { createLanguageModelFromConfig } from "../model/aiSdkModel";
import { createEmbeddingClientFromConfig } from "../model/embeddingClient";
import { resolveEmbeddingModelConfig } from "../model/modelConfig";
import { renderStickerDescriptionPrompt } from "../prompts/stickers";
import { StickerDescriptionSchema } from "./schemas";
import type {
  StickerAnalyzer,
  StickerDescriptionInput,
  StickerEmbedder
} from "./models";

const STICKER_MODEL_TIMEOUT_MS = 300_000;

export interface CreateAiStickerModelsOptions {
  fetch?: typeof fetch;
  headers?: Record<string, string>;
  onDescriptionRequest?: (request: Record<string, unknown>) => void;
  onDescriptionResponse?: (response: Record<string, unknown>) => void;
  onEmbeddingRequest?: (request: Record<string, unknown>) => void;
  onEmbeddingResponse?: (response: Record<string, unknown>) => void;
}

export function createAiStickerAnalyzer(
  config: GestaltConfig,
  options: CreateAiStickerModelsOptions = {}
): StickerAnalyzer {
  const resolved = createLanguageModelFromConfig(config, {
    role: "sub",
    supportsStructuredOutputs: true,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.headers ? { headers: options.headers } : {})
  });
  return {
    async describe(input: StickerDescriptionInput) {
      const prompt = renderStickerDescriptionPrompt(input);
      options.onDescriptionRequest?.({
        provider: resolved.providerName,
        model: resolved.modelName,
        promptId: prompt.id,
        promptHash: prompt.hash,
        mime: input.mime,
        byteLength: input.image.byteLength,
        animated: input.animated,
        frameCount: input.frameCount
      });
      const result = await generateText({
        model: resolved.languageModel,
        output: Output.object({
          schema: StickerDescriptionSchema,
          name: "sticker_description",
          description: "Objective visual description, emotion tags, and natural IM usage examples."
        }),
        abortSignal: AbortSignal.timeout(STICKER_MODEL_TIMEOUT_MS),
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt.content },
              {
                type: "file",
                data: input.image,
                mediaType: input.mime
              }
            ]
          }
        ],
        ...(resolved.temperature !== undefined
          ? { temperature: resolved.temperature }
          : {}),
        maxRetries: 2
      });
      const description = normalizeDescription(result.output);
      options.onDescriptionResponse?.({
        provider: resolved.providerName,
        model: resolved.modelName,
        description,
        usage: result.usage
      });
      return {
        description,
        provider: resolved.providerName,
        model: resolved.modelName,
        promptHash: prompt.hash,
        usage: result.usage
      };
    }
  };
}

export function createAiStickerEmbedder(
  config: GestaltConfig,
  options: CreateAiStickerModelsOptions = {}
): StickerEmbedder {
  const resolved = resolveEmbeddingModelConfig(config);
  const id = resolved.id;
  const client = createEmbeddingClientFromConfig(config, {
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.headers ? { headers: options.headers } : {}),
    onRequest(request) {
      options.onEmbeddingRequest?.({ ...request, id });
    },
    onResponse(response) {
      options.onEmbeddingResponse?.({ ...response, id });
    }
  });
  return {
    provider: client.providerName,
    model: client.modelName,
    id,
    ...(client.dimensions ? { configuredDimensions: client.dimensions } : {}),
    async embed(text, embedOptions) {
      const queryInstruction = embedOptions?.queryPurpose === "visual"
        ? "Retrieve an objective sticker visual description matching the request"
        : embedOptions?.queryPurpose === "tags"
          ? "Retrieve sticker emotion and reaction tags matching the request"
          : "Retrieve an IM message with the same conversational intent and reaction";
      return {
        vector: await client.embed(text, {
          signal: AbortSignal.timeout(STICKER_MODEL_TIMEOUT_MS),
          ...(embedOptions?.inputType
            ? { inputType: embedOptions.inputType }
            : {}),
          ...(embedOptions?.inputType === "query" ? { queryInstruction } : {})
        })
      };
    }
  };
}

function normalizeDescription(
  value: typeof StickerDescriptionSchema._output
): typeof StickerDescriptionSchema._output {
  const visual = value.visual.replace(/\s+/g, " ").trim();
  const emotion = uniqueNormalized(value.emotion, (entry) =>
    entry.toLowerCase().replace(/\s+/g, " ").trim()
  );
  const usage = uniqueNormalized(value.usage, (entry) =>
    entry.replace(/\s+/g, " ").trim()
  );
  return StickerDescriptionSchema.parse({ visual, emotion, usage });
}

function uniqueNormalized(
  values: readonly string[],
  normalize: (value: string) => string
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = normalize(value);
    const comparison = normalized
      .toLowerCase()
      .replace(/[\s，。！？!?、,.]+/g, "");
    if (!normalized || !comparison || seen.has(comparison)) {
      continue;
    }
    seen.add(comparison);
    result.push(normalized);
  }
  return result;
}
