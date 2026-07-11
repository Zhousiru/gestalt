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
  renderInspectTaskPrompt
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
assert.match(action.content, /call leave as your final tool/);
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

console.log(
  JSON.stringify({
    ok: true,
    actionPrompt: { id: action.id, contentHash: action.contentHash },
    dreamingPrompt: { id: dreaming.id, contentHash: dreaming.contentHash },
    tools: names.length,
    toolPromptHash: hashModelToolPrompts(names)
  }, null, 2)
);
