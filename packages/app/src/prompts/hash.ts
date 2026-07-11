import { createHash } from "node:crypto";
import type { PromptId, RenderedPrompt } from "./types";

export function normalizePrompt(content: string): string {
  return content
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

export function hashPromptContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

export function createRenderedPrompt(
  id: PromptId,
  content: string
): RenderedPrompt {
  const normalized = normalizePrompt(content);
  return {
    id,
    content: normalized,
    contentHash: hashPromptContent(normalized)
  };
}
