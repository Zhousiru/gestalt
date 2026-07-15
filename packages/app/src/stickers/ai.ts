import { generateText } from "ai";
import type { GestaltConfig } from "../home/loadConfig";
import { createLanguageModelFromConfig } from "../model/aiSdkModel";
import { createEmbeddingClientFromConfig } from "../model/embeddingClient";
import { resolveEmbeddingModelConfig } from "../model/modelConfig";
import { renderStickerDescriptionPrompt } from "../prompts/stickers";
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
      const desc = normalizeDescription(result.text);
      options.onDescriptionResponse?.({
        provider: resolved.providerName,
        model: resolved.modelName,
        desc,
        usage: result.usage
      });
      return {
        desc,
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
      return {
        vector: await client.embed(text, {
          signal: AbortSignal.timeout(STICKER_MODEL_TIMEOUT_MS),
          ...(embedOptions?.inputType
            ? { inputType: embedOptions.inputType }
            : {})
        })
      };
    }
  };
}

function normalizeDescription(value: string): string {
  const trimmed = value
    .trim()
    .replace(/^```(?:text)?\s*/i, "")
    .replace(/\s*```$/, "")
    .replace(/\s+/g, " ");
  if (!trimmed) {
    throw new Error("Sticker analyzer returned an empty description.");
  }
  if (trimmed.length > 2000) {
    throw new Error("Sticker analyzer returned a description longer than 2000 characters.");
  }
  return trimmed;
}
