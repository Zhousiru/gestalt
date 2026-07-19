import { hashPromptContent } from "./hash";

export const STICKER_DESCRIPTION_PROMPT_ID = "sticker-description";

const stickerDescriptionPrompt = [
  "Analyze this chat sticker into the requested structured fields.",
  "visual: Write in English. Describe only objectively visible content: subjects, count, appearance, posture, physical action, objects, composition, readable text, and animation. Do not infer emotion, intent, conversational meaning, or a usage scenario. Prefer physical cues such as 'raised eyebrows' over interpretations such as 'looks confused'.",
  "emotion: Return 1 to 8 concise canonical English emotion or reaction tags that are directly supported by the image, such as happy, excited, smug, shy, hurt, sad, angry, disgusted, speechless, confused, shocked, scared, awkward, tired, resigned, suspicious, or helpless. Do not include visual nouns or complete phrases.",
  "usage: Return 10 to 20 distinct, natural, short Chinese IM messages that could accompany this sticker. Write messages ready to send, not explanations of when to use them. Cover genuinely different phrasings and intents; do not pad the list with punctuation-only or particle-only variants.",
  "Keep readable text in the image verbatim inside visual. Do not mention uncertainty or provide alternatives outside the requested fields."
].join("\n");

export function renderStickerDescriptionPrompt(input: {
  animated: boolean;
  frameCount: number;
  platformSummary?: string;
}): { id: string; content: string; hash: string } {
  const animation = input.animated
    ? [
        `The input is a 4x4 contact sheet sampled evenly over one animation loop from ${input.frameCount} source frames. Read it left-to-right, top-to-bottom as time.`,
        "Infer the most likely complete motion or action from changes across the frames, including what the subject starts doing, how it moves or changes, and whether the action repeats or ends.",
        "Describe what the subject is doing as one coherent action rather than listing individual frames."
      ].join("\n")
    : "The input is one static sticker image.";
  const summary = input.platformSummary
    ? `Platform-provided summary (only a hint, verify against the image): ${input.platformSummary}`
    : undefined;
  const content = [stickerDescriptionPrompt, animation, summary]
    .filter((value): value is string => Boolean(value))
    .join("\n");
  return {
    id: STICKER_DESCRIPTION_PROMPT_ID,
    content,
    hash: hashPromptContent(content)
  };
}
