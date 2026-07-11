import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { DREAMING_TOOL_PROMPTS } from "../prompts/tools";

export const dreamingToolOrder = ["bash", "finish_dreaming"] as const;

export interface DreamingCommandExecutor {
  exec(command: string): Promise<unknown>;
}

/**
 * The dreaming tools are part of the stable provider tool protocol from the
 * first action request onward. Their executor is activated only for the
 * terminal dreaming phase, which keeps the provider prefix cacheable without
 * allowing memory writes during the action phase.
 */
export function buildDreamingTools(
  executor?: DreamingCommandExecutor
): ToolSet {
  return {
    bash: tool({
      description: DREAMING_TOOL_PROMPTS.bash.description,
      inputSchema: z
        .object({
          command: z
            .string()
            .min(1)
            .describe(DREAMING_TOOL_PROMPTS.bash.parameters.command)
        })
        .strict(),
      async execute({ command }) {
        if (!executor) {
          return {
            status: "unavailable",
            reason: "bash is disabled until the terminal dreaming phase."
          };
        }
        return executor.exec(command);
      }
    }),
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
