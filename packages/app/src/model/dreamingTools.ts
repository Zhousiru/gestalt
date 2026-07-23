import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { DREAMING_TOOL_PROMPTS } from "../prompts/tools";
import { createModelBashTool } from "./bashTool";

export const dreamingToolOrder = ["finish_dreaming"] as const;

export interface DreamingCommandExecutor {
  exec(command: string): Promise<unknown>;
}

export function buildDreamingTools(
  executor: DreamingCommandExecutor
): ToolSet {
  return {
    bash: createModelBashTool((command) => executor.exec(command)),
    ...buildTerminalDreamingTools(executor)
  };
}

/**
 * finish_dreaming stays in the provider protocol from the first action step,
 * but only terminal dreaming gives it an executor.
 */
export function buildTerminalDreamingTools(
  executor?: DreamingCommandExecutor
): ToolSet {
  return {
    finish_dreaming: tool({
      description: DREAMING_TOOL_PROMPTS.finish_dreaming.description,
      inputSchema: z
        .object({
          summary: z
            .string()
            .min(1)
            .describe(DREAMING_TOOL_PROMPTS.finish_dreaming.parameters.summary)
        })
        .strict(),
      async execute({ summary }) {
        if (!executor) {
          return {
            status: "unavailable",
            reason:
              "finish_dreaming is disabled until the terminal dreaming phase."
          };
        }
        return { status: "completed", summary };
      }
    })
  };
}
