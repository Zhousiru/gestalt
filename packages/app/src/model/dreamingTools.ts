import { tool, type ToolSet } from "ai";
import { z } from "zod";

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
      description:
        "Terminal dreaming phase only. Run one executable bash command in a virtual filesystem where only /memories is writable and persistent. Never use during the normal chat-action phase.",
      inputSchema: z
        .object({
          command: z
            .string()
            .min(1)
            .describe(
              "Executable shell code to run. Use paths under /memories for memory files. Examples: cat /memories/self/index.md ; printf 'text' >> /memories/users/alice/index.md"
            )
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
      description:
        "Terminal dreaming phase only. Finish after all useful memory inspection and updates are complete. Never use during the normal chat-action phase.",
      inputSchema: z
        .object({
          summary: z
            .string()
            .min(1)
            .describe(
              "Short summary of what memory was updated, or why no update was needed."
            )
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
