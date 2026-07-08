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
assert.match(transcriptText, /\[CQ:image,file=cat\.png/);
assert.match(transcriptText, /\[CQ:face,id=14,name=微笑\]/);
assert.ok(apiCall, "expected send_group_msg API call");
assert.equal(apiCall.params?.group_id, 123456);
const action = turn.proposedActions.find(
  (candidate) => candidate.toolName === "send_group_message"
);
assert.ok(action, "expected OneBot e2e to propose send_group_message");
assert.equal(action.toolName, "send_group_message");
assert.match(action.params.text, /\[CQ:reply,id=321\]/);
if (fetchCall) {
  assert.deepEqual(fetchCall.params, {
    message_id: 111
  });
}
if (readImageCall) {
  assert.deepEqual(readImageCall.params, {
    file: "cat.png"
  });
}
const sentMessage = apiCall.params.message;
assert.equal(typeof sentMessage, "string", "expected CQ string message");
assert.match(String(sentMessage), /\[CQ:reply,id=321\]/);
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
