import { createRenderedPrompt } from "./hash";
import type { RenderedPrompt } from "./types";

export interface DreamingTaskPromptInput {
  participants: string;
}

export function renderDreamingTaskPrompt(
  input: DreamingTaskPromptInput
): RenderedPrompt {
  return createRenderedPrompt(
    "runtime.dreaming.task",
    [
      "Now you are dreaming.",
      "The conversation and your actions above are what you just lived through. Do not ask for them to be repeated.",
      "Infer only memories likely to change a future judgment or interaction: stable identity, preferences or boundaries; relationship changes or shared milestones; recurring patterns or group norms; durable commitments or open threads; and corrections to existing memory.",
      "Do not archive the conversation. Omit ordinary remarks, greetings, one-off requests, transient states, routine interaction behavior, per-interaction records, and details recoverable from the transcript. Usually, make no memory change.",
      "Preserve enduring meaning, not wording or a detailed account of what someone said or did.",
      "Your memories are Markdown files under /memories, the only writable place in the virtual filesystem. Shape them by calling bash.",
      "Do not write bash commands in normal message text; call the bash tool instead.",
      "The bash command argument must be executable shell code, not an explanation or status sentence.",
      "If a bash command fails, inspect the tool result and recover with another bash command.",
      "Use concise bash commands. Prefer cat, mkdir, printf, test, and redirection.",
      "Always inspect relevant index files before writing.",
      "What stays with you belongs under /memories/self/. What you remember about someone belongs under /memories/users/<id>/.",
      "If the conversation corrects an existing memory, edit or replace the old claim instead of appending a contradictory new note.",
      "If the conversation says a memory is stale or no longer current, delete or rewrite the stale wording so it no longer reads as current truth.",
      "Never access files outside /memories.",
      "",
      "Where your memories live:",
      "- /memories/self/index.md",
      "- /memories/self/<subject>.md",
      "- /memories/users/<id>/index.md",
      "- /memories/users/<id>/<subject>.md",
      "",
      "People who were here:",
      input.participants || "(none)",
      "",
      "Use bash only if memory should change, then call finish_dreaming.",
      "Keep files concise and narrative. Generalize; do not quote or log. Correct, prune, or rewrite stale/conflicting memory instead of accumulating contradictions.",
      "Do not answer with status JSON or normal message text."
    ].join("\n")
  );
}
