import assert from "node:assert/strict";
import { createOneBotSendMessage } from "@gestalt/app";
import { runToolContractE2E } from "./toolContractRunner";

const result = await runToolContractE2E();

assert.deepEqual(
  result.proposals.map((proposal) => proposal.toolName),
  [
    "say_nothing",
    "fetch_message",
    "read_image",
    "send_group_message",
    "send_dm",
    "send_image",
    "send_sticker",
    "react_to_message",
    "poke_user",
    "recall_own_message",
    "leave"
  ]
);
assert.deepEqual(
  result.mockToolCalls.map((call) => call.toolName),
  result.proposals.map((proposal) => proposal.toolName)
);
assert.deepEqual(
  result.mockToolResults.map((item) => item.status),
  [
    "skipped",
    "executed",
    "executed",
    "executed",
    "executed",
    "executed",
    "executed",
    "executed",
    "executed",
    "executed",
    "skipped"
  ]
);

const fetchMessage = findCall("get_msg");
assert.deepEqual(fetchMessage.params, {
  message_id: 111
});

const readImage = findCall("get_image");
assert.deepEqual(readImage.params, {
  file: "cat.png"
});

const sendGroup = findCall("send_group_msg");
assert.equal(sendGroup.params?.group_id, 123456);
assert.equal(sendGroup.params?.auto_escape, false);
assert.equal(
  sendGroup.params?.message,
  "[CQ:reply,id=321]群里收到 [CQ:face,id=14,name=微笑]"
);

const sendPrivate = findCall("send_private_msg");
assert.equal(sendPrivate.params?.user_id, 424242);
assert.equal(sendPrivate.params?.auto_escape, false);
assert.equal(sendPrivate.params?.message, "私聊收到 [CQ:face,id=14,name=微笑]");

const sendMsgCalls = result.onebotApiCalls.filter(
  (call) => call.action === "send_msg"
);
assert.equal(sendMsgCalls.length, 2);

const imageCall = sendMsgCalls.find((call) =>
  String(call.params?.message ?? "").includes("[CQ:image")
);
assert.ok(imageCall, "expected send_image to use send_msg");
assert.equal(imageCall.params?.message_type, "group");
assert.equal(imageCall.params?.group_id, 123456);
assert.equal(imageCall.params?.auto_escape, false);
assert.equal(
  imageCall.params?.message,
  "[CQ:reply,id=321]图片来了[CQ:image,file=https://example.test/cat.png,summary=示例图片]"
);

const stickerCall = sendMsgCalls.find((call) =>
  String(call.params?.message ?? "").includes("[CQ:mface")
);
assert.ok(stickerCall, "expected send_sticker to use send_msg");
assert.equal(stickerCall.params?.message_type, "group");
assert.equal(stickerCall.params?.group_id, 123456);
assert.equal(stickerCall.params?.auto_escape, false);
assert.equal(
  stickerCall.params?.message,
  "[CQ:reply,id=321][CQ:mface,emoji_package_id=232743,emoji_id=e236bd3faf64e579678ec218df99fdba,key=c643d011575a7054,summary=&#91;敲黑板&#93;]"
);

const reactionCall = findCall("set_msg_emoji_like");
assert.deepEqual(reactionCall.params, {
  message_id: 321,
  emoji_id: "14",
  set: true
});

const pokeCall = findCall("send_poke");
assert.deepEqual(pokeCall.params, {
  group_id: 123456,
  user_id: 424242
});

const recallCall = findCall("delete_msg");
assert.deepEqual(recallCall.params, {
  message_id: 987654
});

assert.equal(
  createOneBotSendMessage({
    text: "[CQ:mface,emoji_package_id=232743,emoji_id=e236,key=opaque,summary=&#91;敲黑板&#93;]"
  }),
  "[CQ:mface,emoji_package_id=232743,emoji_id=e236,key=opaque,summary=&#91;敲黑板&#93;]"
);

console.log(
  JSON.stringify(
    {
      ok: true,
      scenario: result.id,
      tools: result.proposals.map((proposal) => proposal.toolName),
      onebotApiCalls: result.onebotApiCalls.map((call) => call.action),
      artifacts: result.artifactPaths
    },
    null,
    2
  )
);

function findCall(action: string) {
  const call = result.onebotApiCalls.find((candidate) => candidate.action === action);
  assert.ok(call, `expected OneBot API call ${action}`);
  return call;
}
