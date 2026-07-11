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
      "Let what happened settle. Notice what may matter later: something learned about a person, a shared moment, a correction, an unfinished thread, or something that should be let go.",
      "Your memories are Markdown files under /memories, the only writable place in the virtual filesystem. Shape them by calling bash.",
      "Do not write bash commands in normal message text; call the bash tool instead.",
      "The bash command argument must be executable shell code, not an explanation or status sentence.",
      "If a bash command fails, inspect the tool result and recover with another bash command.",
      "Use concise bash commands. Prefer cat, mkdir, printf, test, and redirection.",
      "Always inspect relevant index files before writing.",
      "What stays with you belongs under /memories/self/. What you remember about someone belongs under /memories/users/<id>/.",
      "If the conversation asks you to remember explicit facts or wording, preserve the concrete meaning and important phrases.",
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
      "Use bash to keep what may matter later, then call finish_dreaming when the dream feels complete.",
      "Keep files concise and narrative. Correct, prune, or rewrite stale/conflicting memory instead of accumulating contradictions.",
      "Do not answer with status JSON or normal message text."
    ].join("\n")
  );
}
