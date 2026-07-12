import { hashPromptContent } from "./hash";

export const STICKER_DESCRIPTION_PROMPT_ID = "sticker-description";

const stickerDescriptionPrompt = [
  "Describe this chat sticker in one short English sentence without trailing punctuation, including its visible subject, action, readable text, emotion, and conversational meaning when apparent.",
  "Then append an ASCII period, one space, and 3 to 8 concise English search keywords separated by commas.",
  "When applicable, prefer consistent keywords such as happy, excited, smug, shy, hurt, sad, angry, disgusted, speechless, confused, shocked, scared, awkward, tired, giving up, mocking, comforting, agreeing, refusing, celebrating, or greeting.",
  "Choose only keywords that directly match this sticker; never copy the candidate list wholesale.",
  "Use only English in the entire output. Do not add a label such as keywords.",
  "Output exactly one line and no JSON, Markdown, uncertainty commentary, or alternatives."
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
