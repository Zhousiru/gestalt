import type { ToolDefinition } from "./schemas";

export function createDefaultToolRegistry(): ToolDefinition[] {
  return [
    {
      name: "say_nothing",
      purpose: "Stay silent when the event does not call for visible action.",
      whenUseful: [
        "The bot was not directly addressed.",
        "The conversation is ongoing and a response would feel intrusive.",
        "There is not enough context for a useful social move."
      ],
      avoidWhen: [
        "A user directly asks the bot a clear question.",
        "A visible clarification or refusal is more appropriate."
      ]
    },
    {
      name: "fetch_message",
      purpose:
        "Fetch one message by platform message id, usually to inspect a quoted or replied-to message that is not present in the transcript.",
      whenUseful: [
        "A current message has reply_to=... but no context=reply_target record is present.",
        "The original quoted message is needed to answer without guessing.",
        "A missing forwarded or referenced message would change the social meaning."
      ],
      avoidWhen: [
        "The relevant quoted message is already visible as context=reply_target.",
        "The current message is clear enough without fetching more context.",
        "Fetching would be used to dig through unrelated chat history."
      ]
    },
    {
      name: "read_image",
      purpose:
        "Fetch platform-cached image data or metadata for an image file id from the transcript before commenting on image contents.",
      whenUseful: [
        "A user asks what is in an image or asks the bot to react to the image itself.",
        "The image file id is visible in CQ markup such as [CQ:image,file=...].",
        "The image meaning matters and the current text metadata is not enough."
      ],
      avoidWhen: [
        "The user only asks to resend the image rather than understand it.",
        "No image file id is available.",
        "The image content is not needed for the social response."
      ]
    },
    {
      name: "send_group_message",
      purpose:
        "Send a short message into a group conversation. The text may include CQ markup such as [CQ:reply,id=...] or [CQ:face,id=...].",
      whenUseful: [
        "The bot was directly addressed in a group.",
        "A brief public reply fits the current group context."
      ],
      avoidWhen: [
        "The reply would expose private context.",
        "A private message would be more appropriate.",
        "The message repeats something the bot already said."
      ]
    },
    {
      name: "send_dm",
      purpose:
        "Send a private message to a specific user when the conversation clearly calls for one-on-one follow-up.",
      whenUseful: [
        "The user explicitly asks for a private reply.",
        "A public group reply would expose personal context.",
        "The next useful step is clearly one-on-one and non-intrusive."
      ],
      avoidWhen: [
        "The user did not invite private contact.",
        "The answer belongs in the group conversation.",
        "A DM would feel surprising or socially pushy."
      ]
    },
    {
      name: "send_image",
      purpose:
        "Send an image into the current conversation using a file id, URL, file URI, or base64:// payload, with an optional short caption.",
      whenUseful: [
        "The user asked the bot to send or repeat an image.",
        "The image reference is already present in the transcript or explicitly provided.",
        "A visual reply is more appropriate than text alone."
      ],
      avoidWhen: [
        "The bot would need to invent an image URL or file id.",
        "A text response is enough.",
        "The image could reveal private or unrelated content."
      ]
    },
    {
      name: "send_sticker",
      purpose:
        "Send a platform sticker or QQ expression by copying exact CQ markup such as [CQ:face,...] or [CQ:mface,...] from context.",
      whenUseful: [
        "The user asks the bot to repeat a sticker or platform expression.",
        "A lightweight sticker response fits the group tone.",
        "The exact sticker CQ markup is available in the transcript."
      ],
      avoidWhen: [
        "The sticker id, mface key, or package id is not known.",
        "A sticker would be ambiguous, insensitive, or too noisy.",
        "A text reply is required for clarity."
      ]
    },
    {
      name: "react_to_message",
      purpose:
        "Add or remove a lightweight emoji reaction on an existing message.",
      whenUseful: [
        "A tiny acknowledgement is better than sending a new message.",
        "The target message id and emoji id are known.",
        "The reaction is socially clear and low-noise."
      ],
      avoidWhen: [
        "A visible text answer is expected.",
        "The emoji id is unknown or invented.",
        "The reaction could look passive-aggressive or confusing."
      ]
    },
    {
      name: "poke_user",
      purpose:
        "Send a QQ poke/nudge to a user as a lightweight playful interaction.",
      whenUseful: [
        "The user explicitly asks for a poke.",
        "A tiny playful nudge fits the group tone better than a text reply.",
        "The target user id is known from the transcript."
      ],
      avoidWhen: [
        "The interaction could feel annoying, pushy, or spammy.",
        "The target user id is unknown or guessed.",
        "A normal text reply or reaction is clearer."
      ]
    },
    {
      name: "recall_own_message",
      purpose:
        "Recall a recently sent message from this bot by message id.",
      whenUseful: [
        "The bot just sent a duplicate, mistaken, or socially stale message.",
        "The message id belongs to a bot-sent message visible in the current context or tool result.",
        "Removing the message is better than sending a correction."
      ],
      avoidWhen: [
        "The message was sent by someone else.",
        "The target message id is unknown or guessed.",
        "A visible apology or clarification would be more appropriate."
      ]
    },
    {
      name: "leave",
      purpose:
        "Exit the currently active agent loop and wait for a future pre-trigger activation.",
      whenUseful: [
        "The current active loop has no more useful work to do.",
        "The bot should stop actively following this thread until a new trigger appears."
      ],
      avoidWhen: [
        "A short visible reply is still needed.",
        "The bot should stay active because users are still adding relevant context."
      ]
    }
  ];
}
