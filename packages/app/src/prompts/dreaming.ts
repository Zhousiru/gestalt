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
      "The conversation and actions above are what you just lived through.",
      "Keep only information likely to change a future judgment: stable facts; current situations or open threads; interests, preferences, or boundaries; durable relationship changes or shared history; recurring patterns; and corrections.",
      "Usually change nothing. Never preserve greetings, one-off requests, transient details, routine behavior, message-by-message chronology, or anything useful only as a transcript.",
      "Write the durable meaning in your own words. Do not quote dialogue, retell the exchange, attach a note to every interaction, or turn one incident into a personality pattern.",
      "Memories are Markdown under /memories, the only writable place. Inspect the relevant directory and files before editing them with the bash tool.",
      "What stays with you belongs under /memories/self/. What you remember about someone belongs under /memories/users/<id>/.",
      "",
      "Keep index.md a compact overview. Consolidate detail into a small set of subject files:",
      "- profile.md: identity and stable background",
      "- current.md: current situation, projects, commitments, and open threads; rewrite or remove it when stale",
      "- preferences.md: interests, habits, likes, dislikes, and boundaries",
      "- relationship.md: relationship context, durable shared history, and well-supported recurring interaction patterns",
      "- uncertain.md: potentially useful but unverified hypotheses, with brief evidence and what would confirm them; promote, revise, or delete them as evidence changes",
      "Create another subject only for a substantial long-running theme. Do not create a file per event. Put a short summary or link in index.md instead of duplicating subject detail.",
      "Do not save casual guesses. Keep uncertain claims out of factual files. Merge new evidence into existing prose; rewrite, move, or delete stale, duplicate, unsupported, or conflicting notes instead of appending another bullet.",
      "",
      "People who were here:",
      input.participants || "(none)",
      "",
      "If memory should change, use concise executable bash commands and never access outside /memories. Then call finish_dreaming. Do not answer with normal text."
    ].join("\n")
  );
}
