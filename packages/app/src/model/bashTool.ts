import { tool, type ToolSet } from "ai";
import { z } from "zod";
import {
  ACTION_TOOL_PROMPTS,
  renderActionToolDescription
} from "../prompts/tools";

export type ModelBashExecutor = (command: string) => Promise<unknown>;

export function createModelBashTool(
  executor?: ModelBashExecutor
): ToolSet[string] {
  return tool({
    description: renderActionToolDescription("bash"),
    inputSchema: z
      .object({
        command: z
          .string()
          .min(1)
          .describe(ACTION_TOOL_PROMPTS.bash.parameters.command)
      })
      .strict(),
    async execute({ command }) {
      if (!executor) {
        return {
          status: "unavailable",
          reason: "bash is unavailable in this phase."
        };
      }
      return executor(command);
    }
  }) as unknown as ToolSet[string];
}
