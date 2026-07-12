import assert from "node:assert/strict";
import { createOneBotSendMessage } from "@gestalt/app";
import { runOneBotProtocolE2E } from "./onebotProtocolRunner";

const result = await runOneBotProtocolE2E();
const conversation = result.session.conversations[0];
const turn = conversation?.turns[0];
const apiCall = result.onebotApiCalls.find(
  (call) => call.action === "send_group_msg"
);
const fetchCall = result.onebotApiCalls.find((call) => call.action === "get_msg");
const readImageCall = result.onebotApiCalls.find(
  (call) => call.action === "get_image"
);
const transcriptText = result.modelRequests
  .flatMap((request) =>
    request.messages.map((message) => message.content ?? "")
  )
  .join("\n");
const modelFacingWindows = result.modelRequests
  .flatMap((request) => request.messages)
  .filter((message) => message.role === "user")
  .map((message) => message.content ?? "")
  .filter((content) => content.includes("小格看看这张图"));

assert.ok(conversation, "expected exported OneBot session conversation");
assert.ok(turn, "expected OneBot e2e to complete one agent turn");
assert.equal(result.event.conversation.kind, "group");
assert.equal(result.event.conversation.id, "123456");
assert.equal(result.event.source.connector, "onebot-v11");
assert.equal(result.event.source.accountId, "10001");
assert.equal(result.event.message.mentionsBot, true);
assert.equal(result.event.message.replyToMessageId, "111");
assert.match(result.event.message.text, /\[CQ:reply,id=111\]/);
assert.match(result.event.message.text, /\[CQ:at,qq=10001,name=小格\]/);
assert.match(result.event.message.text, /\[CQ:image,file=cat\.png,url=https:\/\/example\.test\/cat\.png,summary=一张测试图片\]/);
assert.match(result.event.message.text, /\[CQ:face,id=14,name=微笑\]/);
assert.equal(result.event.message.sourceContent?.format, "onebot-v11");
assert.deepEqual(
  result.event.message.sourceContent?.segments.map((segment) => segment.type),
  ["reply", "at", "text", "image", "face", "mface", "image", "image"]
);
assert.equal(
  result.event.message.rawText,
  "[CQ:reply,id=111][CQ:at,qq=10001] 小格看看这张图 [CQ:image,file=cat.png,url=https://example.test/cat.png] [CQ:face,id=14] [CQ:mface,emoji_id=emoji-direct-secret,emoji_package_id=package-direct-secret,key=REAL_DIRECT_MFACE_KEY,url=https://stickers.example.test/direct.gif?signature=SIGNED_DIRECT_TOKEN,file=marketface] [CQ:image,file=custom-sticker-secret.gif,path=C:\\private\\custom-sticker-secret.gif,url=https://stickers.example.test/custom.gif?signature=SIGNED_CUSTOM_TOKEN,sub_type=1] [CQ:image,file=marketface,url=https://stickers.example.test/compat.gif?signature=SIGNED_COMPAT_TOKEN,emoji_id=emoji-compat-secret,emoji_package_id=package-compat-secret,key=REAL_COMPAT_MFACE_KEY]"
);
assert.match(result.event.message.text, /REAL_DIRECT_MFACE_KEY/);
assert.match(result.event.message.text, /SIGNED_CUSTOM_TOKEN/);
assert.match(result.event.message.text, /emoji-compat-secret/);
assert.match(transcriptText, /\[CQ:at,qq=10001\]/);
assert.match(transcriptText, /\[CQ:image,file=cat\.png/);
assert.match(transcriptText, /\[CQ:face,id=14\]/);
assert.doesNotMatch(transcriptText, /\[CQ:face,id=14,name=微笑\]/);
assert.ok(modelFacingWindows.length > 0, "expected agent-facing transcript window");
for (const window of modelFacingWindows) {
  assert.match(window, /\[CQ:mface,[^\]]*REAL_DIRECT_MFACE_KEY/);
  assert.match(window, /\[CQ:image,[^\]]*sub_type=1/);
  assert.match(window, /SIGNED_CUSTOM_TOKEN/);
}
for (const secret of [
  "REAL_DIRECT_MFACE_KEY",
  "REAL_COMPAT_MFACE_KEY",
  "SIGNED_DIRECT_TOKEN",
  "SIGNED_CUSTOM_TOKEN",
  "SIGNED_COMPAT_TOKEN",
  "custom-sticker-secret.gif",
  "C:\\private\\custom-sticker-secret.gif",
  "emoji-direct-secret",
  "package-direct-secret",
  "emoji-compat-secret",
  "package-compat-secret"
]) {
  assert.match(
    transcriptText,
    new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    `model-facing request must preserve complete sticker CQ data: ${secret}`
  );
}
assert.match(transcriptText, /\[CQ:mface(?:,|\])/);
assert.match(transcriptText, /\[CQ:image,[^\]]*sub_type=1/);
assert.ok(apiCall, "expected send_group_msg API call");
assert.equal(apiCall.params?.group_id, 123456);
const action = turn.proposedActions.find(
  (candidate) => candidate.toolName === "send_group_message"
);
assert.ok(action, "expected OneBot e2e to propose send_group_message");
assert.equal(action.toolName, "send_group_message");
assert.match(action.params.text, /^\[CQ:reply,id=(?:111|321)\]/);
if (fetchCall) {
  assert.deepEqual(fetchCall.params, {
    message_id: 111
  });
}
assert.ok(readImageCall, "expected the model to inspect the image before replying");
assert.deepEqual(readImageCall.params, {
  file: "cat.png"
});
assert.match(transcriptText, /"type":"file"/);
assert.match(transcriptText, /"mediaType":"image\/png"/);
const sentMessage = apiCall.params.message;
assert.equal(typeof sentMessage, "string", "expected CQ string message");
assert.match(String(sentMessage), /^\[CQ:reply,id=(?:111|321)\]/);
if (action.params.text.includes("[CQ:face")) {
  assert.match(String(sentMessage), /\[CQ:face,id=14/);
}
assert.equal(createOneBotSendMessage({
  text: "[CQ:reply,id=321]复读 [CQ:face,id=14,name=微笑]"
}), "[CQ:reply,id=321]复读 [CQ:face,id=14,name=微笑]");

console.log(
  JSON.stringify(
    {
      ok: true,
      scenario: result.id,
      events: conversation.events.length,
      turns: conversation.turns.length,
      messageText: result.event.message.text,
      apiCalls: result.onebotApiCalls.map((call) => call.action),
      modelRequests: result.modelRequests.length,
      artifacts: result.artifactPaths
    },
    null,
    2
  )
);
