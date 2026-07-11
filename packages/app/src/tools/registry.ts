import { ACTION_TOOL_PROMPTS } from "../prompts/tools";
import { ToolNameSchema, type ToolDefinition } from "./schemas";

export function createDefaultToolRegistry(): ToolDefinition[] {
  return ToolNameSchema.options.map((name) => {
    const prompt = ACTION_TOOL_PROMPTS[name];
    return {
      name,
      purpose: prompt.purpose,
      whenUseful: [...prompt.whenUseful],
      avoidWhen: [...prompt.avoidWhen]
    };
  });
}
