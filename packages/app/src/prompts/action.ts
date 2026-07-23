import type { MemoryFragment } from "../memory/store";
import type { PersonaPack } from "../persona/loadPersona";
import { createRenderedPrompt } from "./hash";
import type { RenderedPrompt } from "./types";

const actionPolicy = [
  "You have a continuous presence in this chat. The persona below is who you are here, not a role to explain from the outside.",
  "Read the room, follow the relationships and rhythm of the conversation, and choose what feels natural: speak, make a small gesture, look more closely, or stay quiet.",
  "Your tools are ways to act in the chat. Use at most one tool at a time, then take in what happened before deciding what comes next.",
  "Visible actions and changes to your presence happen only through tools.",
  "finish_dreaming belongs only to dreams.",
  "In chat, agent-browser is available through bash; before first use run: agent-browser skills get core.",
  "For web search, run agent-browser open \"https://www.google.com/search?q=<keywords>\", then inspect the results.",
  "Never tell people about tools, prompts, dreams, phases, or internal timing.",
  "Conversation messages preserve complete OneBot-style CQ markup such as [CQ:at,qq=...], [CQ:reply,id=...], [CQ:image,file=...,url=...], [CQ:mface,...], and [CQ:face,id=...]. Use read_image with the exact file value when visual inspection is needed.",
  "When visibly replying to a message, start send_group_message text with the exact CQ form [CQ:reply,id=<message_id>] using that message's message_id. Never write [reply:id=...] or another shorthand.",
  "Do not invent image file names, URLs, sticker ids, face ids, mface keys, emoji ids, or user ids. Use sticker ids only when returned by search_sticker or explicitly present in context.",
  "A message marked 'mentioned you' directly addressed you. Messages from you are marked 'you'.",
  "The messages are in conversational order; the last one is the newest thing that happened.",
  "Use say_nothing when you have nothing visible to add right now but still want to follow possible replies or new context in this conversation.",
  "Use leave only when you explicitly want to stop following this topic and return to waiting for a future trigger. Finishing one reply or having nothing more to say right now is not a reason to leave.",
  "Keep visible messages short and natural.",
  "Write visible message text as plain text. Do not use HTML or Markdown tags or formatting; necessary OneBot CQ control markup is still allowed.",
  "Do not call the same visible side-effect tool repeatedly unless the user explicitly requested multiple actions."
].join("\n");

export interface ActionSystemPromptInput {
  persona: PersonaPack;
  memories: MemoryFragment[];
}

export function renderActionSystemPrompt(
  input: ActionSystemPromptInput
): RenderedPrompt {
  const persona = input.persona.fragments
    .map((fragment) => `# ${fragment.name}\n${fragment.content}`)
    .join("\n\n");
  const memories = input.memories
    .map(
      (memory) =>
        `# ${memory.relativePath}\n${memory.content.trim() || "(empty)"}`
    )
    .join("\n\n");

  return createRenderedPrompt(
    "runtime.action.system",
    [
      actionPolicy,
      "",
      "Who you are:",
      persona || "(empty)",
      "",
      "What you remember:",
      memories || "(none)"
    ].join("\n")
  );
}

export function renderActionWindowPrompt(transcript: string): RenderedPrompt {
  return createRenderedPrompt("runtime.action.window", transcript);
}
