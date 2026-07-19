export interface StickerDescriptionInput {
  image: Uint8Array;
  mime: string;
  animated: boolean;
  frameCount: number;
  platformSummary?: string;
}

export interface StickerDescriptionResult {
  description: StickerDescription;
  provider: string;
  model: string;
  promptHash: string;
  usage?: unknown;
}

export interface StickerAnalyzer {
  describe(input: StickerDescriptionInput): Promise<StickerDescriptionResult>;
}

export interface StickerEmbeddingResult {
  vector: number[];
  usage?: unknown;
}

export interface StickerEmbeddingOptions {
  inputType?: "document" | "query";
  queryPurpose?: "visual" | "tags" | "usage";
}

export interface StickerEmbedder {
  readonly provider: string;
  readonly model: string;
  readonly id: string;
  readonly configuredDimensions?: number;
  embed(
    text: string,
    options?: StickerEmbeddingOptions
  ): Promise<StickerEmbeddingResult>;
}
import type { StickerDescription } from "./schemas";
