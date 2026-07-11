export type PromptId =
  | "runtime.action.system"
  | "runtime.action.window"
  | "runtime.dreaming.task"
  | "runtime.inspect.system"
  | "runtime.inspect.task";

export interface RenderedPrompt {
  id: PromptId;
  content: string;
  contentHash: string;
}

export interface PromptMetadata {
  id: PromptId;
  contentHash: string;
  toolPromptHash?: string;
}
