/** Sticker explorer wire types remain separate from rollout-first live contracts. */
export interface StickerScrapingView {
  configuredEnabled: boolean;
  runtimeOverride?: boolean;
  effectiveEnabled: boolean;
}

export interface StickerProcessingView {
  queued: number;
  running: number;
  failed: number;
  ready: number;
  duplicates: number;
}

export interface StickerEmbeddingView {
  provider?: string;
  model?: string;
  dimensions?: number;
  id?: string;
  rowCount: number;
  indexState: "empty" | "ready" | "rebuilding" | "error";
  error?: string;
}

export interface StickerJobView {
  id: string;
  stickerId?: string;
  sourceKind: string;
  status: string;
  conversationId: string;
  createdAt: string;
  updatedAt: string;
  stage: string;
  lastFailedStage?: string;
  animated?: boolean;
  error?: string;
  thumbnailUrl?: string;
  contactSheetUrl?: string;
  desc?: string;
}

export interface StickerCatalogItemView {
  id: string;
  desc: string;
  status: string;
  sourceKind: string;
  animated: boolean;
  createdAt: string;
  updatedAt: string;
  thumbnailUrl?: string;
  contactSheetUrl?: string;
  embeddingStatus: string;
  lastError?: string;
}

export interface StickerSnapshot {
  available: boolean;
  unavailableReason?: string;
  generatedAt: string;
  scraping: StickerScrapingView;
  processing: StickerProcessingView;
  embedding: StickerEmbeddingView;
  jobs: StickerJobView[];
  catalog: {
    offset: number;
    limit: number;
    total: number;
  };
  stickers: StickerCatalogItemView[];
}

export type StickerManagementAction = "delete" | "rebuild";

export interface StickerManagementResult {
  stickerId: string;
  ok: boolean;
  outcome: "deleted" | "rebuilt" | "not_found" | "busy" | "failed";
  error?: string;
}

export interface StickerManagementResponse {
  action: StickerManagementAction;
  requested: number;
  succeeded: number;
  failed: number;
  results: StickerManagementResult[];
}

export interface RuntimeLiveEventEnvelope<T = unknown> {
  id: string | number;
  type: string;
  at: string;
  data: T;
}
