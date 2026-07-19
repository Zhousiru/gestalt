import type { ToolName } from "../tools/schemas";
import { hashPromptContent } from "./hash";

export interface ActionToolPrompt {
  purpose: string;
  whenUseful: readonly string[];
  avoidWhen: readonly string[];
  parameters: Readonly<Record<string, string>>;
}

export const ACTION_TOOL_PROMPTS = {
  say_nothing: {
    purpose: "Add nothing visible right now while remaining present for follow-up messages and new context in the active conversation.",
    whenUseful: ["You have finished your visible reply and want to remain available for a response.", "The conversation may continue but there is nothing useful to add yet.", "A response would be intrusive, but you still want to follow what happens next."],
    avoidWhen: ["Someone directly asks you a clear question that still needs an answer.", "A visible clarification or refusal is more appropriate.", "You explicitly want to disengage from this topic entirely."],
    parameters: { reason: "Brief reason for choosing this action." }
  },
  fetch_message: {
    purpose: "Fetch one message by platform message id, usually to inspect a quoted or replied-to message that is not present in the transcript.",
    whenUseful: ["A reply says that its original message is not available in the chat shown to you.", "The original quoted message is needed to answer without guessing.", "A missing forwarded or referenced message would change the social meaning."],
    avoidWhen: ["The relevant quoted message is already expanded beneath the reply.", "The current message is clear enough without fetching more context.", "Fetching would be used to dig through unrelated chat history."],
    parameters: { message_id: "Message id to fetch, copied from reply_to metadata.", reason: "Brief reason for fetching this message." }
  },
  read_image: {
    purpose: "Read the actual platform-cached image for an image file id and return a visual description before commenting on its contents.",
    whenUseful: ["A user asks what is in an image or asks the bot to react to the image itself.", "The image file id is visible in CQ markup such as [CQ:image,file=...].", "The image meaning matters and the current text metadata is not enough."],
    avoidWhen: ["The user only asks to resend the image rather than understand it.", "No image file id is available.", "The image content is not needed for the social response."],
    parameters: { file: "Image file id copied from [CQ:image,file=...] in the transcript.", reason: "Brief reason for reading this image." }
  },
  send_group_message: {
    purpose: "Send a short plain-text message into a group conversation. Do not use HTML or Markdown tags or formatting. OneBot CQ markup such as [CQ:reply,id=...] or [CQ:face,id=...] is allowed only as platform control syntax.",
    whenUseful: ["You were directly addressed in a group.", "A brief public reply fits the current group context."],
    avoidWhen: ["The reply would expose private context.", "A private message would be more appropriate.", "The message repeats something you already said."],
    parameters: { text: "Plain text to send, without HTML or Markdown. May include necessary OneBot CQ control markup such as [CQ:reply,id=321] or [CQ:face,id=14].", reason: "Brief reason for choosing this action." }
  },
  send_dm: {
    purpose: "Send a plain-text private message to a specific user when the conversation clearly calls for one-on-one follow-up. Do not use HTML or Markdown tags or formatting.",
    whenUseful: ["The user explicitly asks for a private reply.", "A public group reply would expose personal context.", "The next useful step is clearly one-on-one and non-intrusive."],
    avoidWhen: ["The user did not invite private contact.", "The answer belongs in the group conversation.", "A DM would feel surprising or socially pushy."],
    parameters: { user_id: "Target user id copied from transcript metadata.", text: "Plain private-message text without HTML or Markdown. May include necessary OneBot CQ control markup.", reason: "Brief reason for choosing this action." }
  },
  send_image: {
    purpose: "Send an image into the current conversation using a file id, URL, file URI, or base64:// payload, with an optional short plain-text caption. Do not use HTML or Markdown in the caption.",
    whenUseful: ["The user asked the bot to send or repeat an image.", "The image reference is already present in the transcript or explicitly provided.", "A visual reply is more appropriate than text alone."],
    avoidWhen: ["You would need to invent an image URL or file id.", "A text response is enough.", "The image could reveal private or unrelated content."],
    parameters: { file: "Image file id, URL, file URI, or base64:// payload copied from context or explicitly provided.", caption: "Optional short plain-text caption without HTML or Markdown.", summary: "Optional image summary for platform metadata.", reply_to_message_id: "Optional message id to quote before the image.", reason: "Brief reason for choosing this action." }
  },
  search_sticker: {
    purpose: "Search your collected sticker library by objective visual content and emotion tags, then return stable sticker ids with objective visual descriptions.",
    whenUseful: ["A sticker could express the reaction more naturally than another text message.", "You know the feeling or social move you want but not a sticker id.", "A lightweight visual response fits the persona and current chat rhythm."],
    avoidWhen: ["A precise factual answer or serious clarification is required.", "You have just used a sticker and another would feel repetitive.", "No sticker response is socially appropriate."],
    parameters: { query: "Short natural-language description of the emotion, attitude, or conversational response to find.", limit: "Optional number of candidates from 1 to 20.", reason: "Brief reason for searching the sticker library." }
  },
  send_sticker: {
    purpose: "Send one collected sticker by its stable sticker id.",
    whenUseful: ["A candidate returned by search_sticker fits the exact reaction.", "A sticker alone is a natural, low-noise response.", "The persona's sticker habits and recent transcript support using one now."],
    avoidWhen: ["You have not obtained the sticker id from search_sticker or visible context.", "A sticker would be ambiguous, insensitive, repetitive, or too noisy.", "A text reply is required for clarity."],
    parameters: { sticker_id: "Stable sticker id returned by search_sticker.", reply_to_message_id: "Optional message id to quote before the sticker.", reason: "Brief reason for choosing this sticker." }
  },
  react_to_message: {
    purpose: "Add or remove a lightweight emoji reaction on an existing message.",
    whenUseful: ["A tiny acknowledgement is better than sending a new message.", "The target message id and emoji id are known.", "The reaction is socially clear and low-noise."],
    avoidWhen: ["A visible text answer is expected.", "The emoji id is unknown or invented.", "The reaction could look passive-aggressive or confusing."],
    parameters: { message_id: "Target message id. Defaults to the latest transcript message when omitted.", emoji_id: "Platform emoji id copied from context or configuration.", remove: "Set true to remove the reaction instead of adding it.", reason: "Brief reason for choosing this action." }
  },
  poke_user: {
    purpose: "Send a QQ poke/nudge to a user as a lightweight playful interaction.",
    whenUseful: ["The user explicitly asks for a poke.", "A tiny playful nudge fits the group tone better than a text reply.", "The target user id is known from the transcript."],
    avoidWhen: ["The interaction could feel annoying, pushy, or spammy.", "The target user id is unknown or guessed.", "A normal text reply or reaction is clearer."],
    parameters: { user_id: "Target user id copied from transcript metadata.", reason: "Brief reason for choosing this action." }
  },
  recall_own_message: {
    purpose: "Recall a recently sent message from this bot by message id.",
    whenUseful: ["You just sent a duplicate, mistaken, or socially stale message.", "The message id belongs to one of your messages visible in the chat or a tool result.", "Removing the message is better than sending a correction."],
    avoidWhen: ["The message was sent by someone else.", "The target message id is unknown or guessed.", "A visible apology or clarification would be more appropriate."],
    parameters: { own_message_id: "Message id for a message sent by you, copied from a tool result externalId or a chat message marked 'you'.", reason: "Brief reason for recalling this bot message." }
  },
  leave: {
    purpose: "Deliberately stop following the current topic, exit its active agent loop, and require a future trigger to become active again.",
    whenUseful: ["You explicitly no longer want to participate in or follow this topic.", "The conversation has clearly moved on and you intentionally want to disengage."],
    avoidWhen: ["You merely finished one reply or have nothing more to say right now.", "A follow-up message or new context is still plausible.", "You want to stay present silently; use say_nothing instead."],
    parameters: { reason: "Brief reason for choosing this action." }
  }
} satisfies Record<ToolName, ActionToolPrompt>;

export const DREAMING_TOOL_PROMPTS = {
  bash: {
    description: "Only while you are dreaming, run one executable bash command in a virtual filesystem where /memories is the only writable and persistent place.",
    parameters: { command: "Executable shell code to inspect or coherently rewrite memory files under /memories. Example: ls /memories/users/alice && cat /memories/users/alice/index.md" }
  },
  finish_dreaming: {
    description: "Only while you are dreaming, finish after your memories feel coherent and no useful inspection or update remains.",
    parameters: { summary: "Short summary of what memory was updated, or why no update was needed." }
  }
} as const;

export const INSPECT_TOOL_PROMPTS = {
  bash: {
    description: "Run one read-only bash command in a virtual filesystem. Mounted evidence: /sessions and /traces. Use this to inspect JSONL files before reporting.",
    parameters: { command: "Executable shell code for read-only inspection. Prefer ls, cat, head, tail, grep-like shell pipelines, and python/json parsing. Do not write files." }
  },
  send_inspect_report: {
    description: "Submit the final inspect diagnosis. This does not send directly to the chat platform; the runtime will send the report text after this tool is called.",
    parameters: { report: "Final diagnosis in plain text. Do not use Markdown formatting, bullet lists, tables, headings, code fences, or links." }
  }
} as const;

export function renderActionToolDescription(name: ToolName): string {
  const prompt = ACTION_TOOL_PROMPTS[name];
  return [
    prompt.purpose,
    `It may feel right when: ${prompt.whenUseful.join("; ")}`,
    `Hold back when: ${prompt.avoidWhen.join("; ")}`
  ].join("\n");
}

export function hashModelToolPrompts(toolNames: readonly ToolName[]): string {
  return hashPromptContent(
    [
      ...toolNames.map((name) => [name, ACTION_TOOL_PROMPTS[name]]),
      ...Object.entries(DREAMING_TOOL_PROMPTS)
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n")
  );
}
