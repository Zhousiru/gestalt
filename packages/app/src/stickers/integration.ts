import { createHash } from "node:crypto";
import type { Connector } from "../connectors/types";
import type { GestaltConfig } from "../home/loadConfig";
import type { GestaltHome } from "../home/resolveGestaltHome";
import type { LiveEventSink } from "../live/viewTypes";
import { redactSensitiveString } from "../privacy/stickerRedaction";
import {
  createConnectorToolImplementations,
  type ToolHandlerResult,
  type ToolImplementation,
  type ToolImplementations
} from "../tools/executeActions";
import type { ActionProposal } from "../tools/schemas";
import { createAiStickerAnalyzer, createAiStickerEmbedder } from "./ai";
import { createStickerVectorIndex } from "./lance";
import { createStickerLogger } from "./logger";
import { createStickerMediaResolver } from "./media";
import { createStickerService, type StickerService } from "./service";
import { createStickerStore } from "./store";

const DEFAULT_STICKER_RECOMMENDATION_PROBABILITY = 0;
const DEFAULT_STICKER_RECOMMENDATION_LIMIT = 3;
const STICKER_RECOMMENDATION_SAMPLE_DOMAIN =
  "gestalt.sticker-recommendation.sha256-53";
const SAMPLE_DENOMINATOR = 2 ** 53;

export interface StickerRecommendationConfig {
  probability: number;
  limit: number;
}

export function isStickerSubsystemConfigured(config: GestaltConfig): boolean {
  return (
    Boolean(config.flatValues.embedding_model_name) ||
    config.flatValues.sticker_scraping_enabled === true ||
    readStickerRecommendationConfig(config).probability > 0
  );
}

export async function createConfiguredStickerService(input: {
  home: GestaltHome;
  config: GestaltConfig;
  connector: Connector;
  liveEvents?: LiveEventSink;
  now?: () => Date;
  fetch?: typeof fetch;
}): Promise<StickerService> {
  const logger = createStickerLogger(input.home);
  const embedder = createAiStickerEmbedder(input.config, {
    ...(input.fetch ? { fetch: input.fetch } : {})
  });
  const vectorIndex = await createStickerVectorIndex({
    directory: input.home.stickerLanceDbDir,
    embeddingId: embedder.id
  });
  return createStickerService({
    home: input.home,
    connector: input.connector,
    store: createStickerStore(input.home),
    logger,
    mediaResolver: createStickerMediaResolver({
      connector: input.connector,
      ...(input.fetch ? { fetch: input.fetch } : {})
    }),
    analyzer: createAiStickerAnalyzer(input.config, {
      ...(input.fetch ? { fetch: input.fetch } : {})
    }),
    embedder,
    vectorIndex,
    configuredEnabled: readStickerScrapingEnabled(input.config),
    processingConcurrency: readStickerProcessingConcurrency(input.config),
    ...(input.liveEvents ? { liveEvents: input.liveEvents } : {}),
    ...(input.now ? { now: input.now } : {})
  });
}

export function createStickerToolImplementations(
  service: StickerService
): ToolImplementations {
  return {
    async search_sticker(proposal, context) {
      if (proposal.toolName !== "search_sticker") {
        return {
          status: "failed",
          reason: `search_sticker handler received ${proposal.toolName}.`
        };
      }
      try {
        const stickers = await service.search({
          query: proposal.params.query,
          source: "tool",
          ...(proposal.params.limit ? { limit: proposal.params.limit } : {}),
          ...(context.traceId ? { agentTraceId: context.traceId } : {})
        });
        return {
          status: "executed",
          result: {
            ok: true,
            data: {
              stickers: stickers.map((sticker) => ({
                sticker_id: sticker.stickerId,
                desc: sticker.desc
              }))
            }
          }
        };
      } catch (error) {
        return {
          status: "failed",
          result: { ok: false, error: errorMessage(error) }
        };
      }
    },

    async send_sticker(proposal, context) {
      if (proposal.toolName !== "send_sticker") {
        return {
          status: "failed",
          reason: `send_sticker handler received ${proposal.toolName}.`
        };
      }
      const result = await service.send({
        conversation: proposal.params.conversation,
        stickerId: proposal.params.stickerId,
        ...(proposal.params.replyToMessageId
          ? { replyToMessageId: proposal.params.replyToMessageId }
          : {}),
        ...(context.traceId ? { agentTraceId: context.traceId } : {})
      });
      return {
        status: result.ok ? "executed" : "failed",
        result
      };
    }
  };
}

export function withStickerRecommendations(input: {
  service: StickerService;
  config: StickerRecommendationConfig;
  implementations: ToolImplementations;
}): ToolImplementations {
  if (input.config.probability === 0) {
    return input.implementations;
  }
  const defaults = createConnectorToolImplementations();
  const sendGroupMessage =
    input.implementations.send_group_message ?? defaults.send_group_message;
  const sendDm = input.implementations.send_dm ?? defaults.send_dm;
  return {
    ...input.implementations,
    ...(sendGroupMessage
      ? {
          send_group_message: withTextSendRecommendations(
            sendGroupMessage,
            input.service,
            input.config
          )
        }
      : {}),
    ...(sendDm
      ? {
          send_dm: withTextSendRecommendations(
            sendDm,
            input.service,
            input.config
          )
        }
      : {})
  };
}

export function readStickerRecommendationConfig(
  config: GestaltConfig
): StickerRecommendationConfig {
  const probabilityValue =
    config.flatValues.sticker_recommendation_probability;
  const probability =
    probabilityValue === undefined
      ? DEFAULT_STICKER_RECOMMENDATION_PROBABILITY
      : probabilityValue;
  if (
    typeof probability !== "number" ||
    !Number.isFinite(probability) ||
    probability < 0 ||
    probability > 1
  ) {
    throw new Error(
      "sticker_recommendation_probability must be a number between 0 and 1."
    );
  }

  const limitValue = config.flatValues.sticker_recommendation_limit;
  const limit =
    limitValue === undefined ? DEFAULT_STICKER_RECOMMENDATION_LIMIT : limitValue;
  if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 20) {
    throw new Error(
      "sticker_recommendation_limit must be an integer between 1 and 20."
    );
  }
  return { probability, limit: Number(limit) };
}

export function sampleStickerRecommendation(
  proposal: Pick<ActionProposal, "id" | "toolName">
): number {
  const digest = createHash("sha256")
    .update(
      [STICKER_RECOMMENDATION_SAMPLE_DOMAIN, proposal.toolName, proposal.id].join(
        "\0"
      )
    )
    .digest();
  const sampleBits = digest.readBigUInt64BE(0) >> 11n;
  return Number(sampleBits) / SAMPLE_DENOMINATOR;
}

export function readStickerScrapingEnabled(config: GestaltConfig): boolean {
  const value = config.flatValues.sticker_scraping_enabled;
  if (value === undefined) {
    return false;
  }
  if (typeof value !== "boolean") {
    throw new Error("sticker_scraping_enabled must be a boolean.");
  }
  return value;
}

function withTextSendRecommendations(
  implementation: ToolImplementation,
  service: StickerService,
  config: StickerRecommendationConfig
): ToolImplementation {
  return async (proposal, context) => {
    const result = await implementation(proposal, context);
    if (
      result.status !== "executed" ||
      result.result?.ok !== true ||
      sampleStickerRecommendation(proposal) >= config.probability
    ) {
      return result;
    }
    const query = textSendRecommendationQuery(proposal);
    if (!query) {
      return result;
    }
    try {
      const stickers = await service.search({
        query,
        limit: config.limit,
        source: "recommendation",
        ...(context.traceId ? { agentTraceId: context.traceId } : {})
      });
      return attachStickerRecommendations(
        result,
        stickers.map((sticker) => ({
          sticker_id: sticker.stickerId,
          desc: sticker.desc
        }))
      );
    } catch {
      // Sending already succeeded. Recommendation is best-effort and the
      // sticker service records its own typed search failure.
      return result;
    }
  };
}

function textSendRecommendationQuery(proposal: ActionProposal): string {
  if (
    proposal.toolName !== "send_group_message" &&
    proposal.toolName !== "send_dm"
  ) {
    return "";
  }
  return proposal.params.text
    .replace(/\[CQ:[A-Za-z0-9_-]+(?:,[^\]]*)?\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1000);
}

function attachStickerRecommendations(
  result: ToolHandlerResult,
  recommendations: Array<{ sticker_id: string; desc: string }>
): ToolHandlerResult {
  if (!result.result) {
    return result;
  }
  const existingData = result.result.data;
  const data = isRecord(existingData)
    ? { ...existingData, recommended_stickers: recommendations }
    : existingData === undefined
      ? { recommended_stickers: recommendations }
      : {
          connector_data: existingData,
          recommended_stickers: recommendations
        };
  return {
    ...result,
    result: {
      ...result.result,
      data
    }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function readStickerProcessingConcurrency(config: GestaltConfig): number {
  const value = config.flatValues.sticker_processing_concurrency;
  if (value === undefined) {
    return 1;
  }
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 32) {
    throw new Error(
      "sticker_processing_concurrency must be an integer between 1 and 32."
    );
  }
  return parsed;
}

export function readOperatorUserIds(config: GestaltConfig): Set<string> {
  const value = config.flatValues.operator_user_ids;
  if (value === undefined) {
    return new Set();
  }
  if (!Array.isArray(value)) {
    throw new Error("operator_user_ids must be an array of user ids.");
  }
  return new Set(value.map((entry) => String(entry)));
}

function errorMessage(error: unknown): string {
  return redactSensitiveString(
    error instanceof Error ? error.message : String(error)
  ).slice(0, 1000);
}
