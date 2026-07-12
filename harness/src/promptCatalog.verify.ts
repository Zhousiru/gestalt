import assert from "node:assert/strict";
import {
  ACTION_TOOL_PROMPTS,
  ToolNameSchema,
  createDefaultToolRegistry,
  hashModelToolPrompts,
  renderActionSystemPrompt,
  renderActionWindowPrompt,
  renderDreamingTaskPrompt,
  renderInspectSystemPrompt,
  renderInspectTaskPrompt,
  renderStickerDescriptionPrompt
} from "@gestalt/app";

const action = renderActionSystemPrompt({
  persona: {
    homeRoot: "/fixture",
    version: "fixture",
    fragments: []
  },
  memories: []
});
assert.equal(action.id, "runtime.action.system");
assert.match(action.contentHash, /^[a-f0-9]{16}$/);
assert.match(action.content, /Use say_nothing when you have nothing visible to add right now/);
assert.match(action.content, /Use leave only when you explicitly want to stop following this topic/);
assert.match(action.content, /Finishing one reply or having nothing more to say right now is not a reason to leave/);
assert.doesNotMatch(action.content, /call leave as your final tool/);
assert.match(action.content, /Write visible message text as plain text/);
assert.match(action.content, /Do not use HTML or Markdown/);
assert.match(ACTION_TOOL_PROMPTS.send_group_message.purpose, /plain-text message/);
assert.match(ACTION_TOOL_PROMPTS.send_dm.parameters.text, /without HTML or Markdown/);
assert.match(ACTION_TOOL_PROMPTS.send_image.parameters.caption, /without HTML or Markdown/);
assert.doesNotMatch(action.content, /there is no lifecycle tool/i);
assert.equal(
  action.contentHash,
  renderActionSystemPrompt({
    persona: { homeRoot: "/other", version: "other", fragments: [] },
    memories: []
  }).contentHash
);

const windowPrompt = renderActionWindowPrompt("one deterministic window");
assert.equal(windowPrompt.content, "one deterministic window");

const dreaming = renderDreamingTaskPrompt({ participants: "- Alice (id=alice)" });
assert.match(dreaming.content, /conversation and your actions above/);
assert.match(dreaming.content, /finish_dreaming/);
assert.match(dreaming.content, /Infer only memories likely to change a future judgment or interaction/);
assert.match(dreaming.content, /Usually, make no memory change/);
assert.match(dreaming.content, /per-interaction records/);
assert.match(dreaming.content, /not wording or a detailed account/);
assert.match(dreaming.content, /Generalize; do not quote or log/);
assert.doesNotMatch(dreaming.content, /asked to remember|asks? you to remember|explicit memory request/i);
assert.doesNotMatch(dreaming.content, /preserve the concrete meaning and important phrases/);

assert.match(renderInspectSystemPrompt().content, /read-only bash tool/);
assert.match(
  renderInspectTaskPrompt({
    now: "2026-07-11T00:00:00.000Z",
    query: "",
    conversation: "group:test",
    eventId: "event-1",
    sessionSeq: 1,
    messageId: "message-1",
    sender: "Alice (alice)",
    receivedAt: "2026-07-11T00:00:00.000Z",
    text: "/inspect",
    conversationSummary: "(conversation not found in current snapshot)"
  }).content,
  /\(no explicit inspect query;/
);

const names = ToolNameSchema.options;
assert.deepEqual(Object.keys(ACTION_TOOL_PROMPTS), names);
assert.deepEqual(
  createDefaultToolRegistry().map((tool) => tool.name),
  names
);
assert.match(hashModelToolPrompts(names), /^[a-f0-9]{16}$/);

const staticStickerPrompt = renderStickerDescriptionPrompt({
  animated: false,
  frameCount: 1
});
const animatedStickerPrompt = renderStickerDescriptionPrompt({
  animated: true,
  frameCount: 20,
  platformSummary: "[动画表情]"
});
assert.equal(staticStickerPrompt.id, "sticker-description");
assert.match(staticStickerPrompt.content, /one short English sentence/);
assert.match(staticStickerPrompt.content, /English search keywords/);
assert.match(staticStickerPrompt.content, /happy, excited, smug/);
assert.match(staticStickerPrompt.content, /never copy the candidate list wholesale/);
assert.match(staticStickerPrompt.content, /Do not add a label/);
assert.match(staticStickerPrompt.content, /only English in the entire output/);
assert.match(staticStickerPrompt.content, /one static sticker image/);
assert.doesNotMatch(staticStickerPrompt.content, /4x4 contact sheet/);
assert.match(animatedStickerPrompt.content, /4x4 contact sheet/);
assert.match(animatedStickerPrompt.content, /sampled evenly/);
assert.match(animatedStickerPrompt.content, /20 source frames/);
assert.match(animatedStickerPrompt.content, /left-to-right, top-to-bottom/);
assert.match(animatedStickerPrompt.content, /Infer the most likely complete motion or action/);
assert.match(animatedStickerPrompt.content, /one coherent action/);
assert.match(animatedStickerPrompt.content, /only a hint/);
assert.notEqual(animatedStickerPrompt.hash, staticStickerPrompt.hash);
assert.equal(
  animatedStickerPrompt.hash,
  renderStickerDescriptionPrompt({
    animated: true,
    frameCount: 20,
    platformSummary: "[动画表情]"
  }).hash
);
assert.match(animatedStickerPrompt.hash, /^[a-f0-9]{16}$/);

console.log(
  JSON.stringify({
    ok: true,
    actionPrompt: { id: action.id, contentHash: action.contentHash },
    dreamingPrompt: { id: dreaming.id, contentHash: dreaming.contentHash },
    stickerPrompt: {
      id: animatedStickerPrompt.id,
      hash: animatedStickerPrompt.hash
    },
    tools: names.length,
    toolPromptHash: hashModelToolPrompts(names)
  }, null, 2)
);
