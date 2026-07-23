import assert from "node:assert/strict";
import { createOneBotSendMessage } from "@gestalt/app";
import { runToolContractE2E } from "./toolContractRunner";

const result = await runToolContractE2E();

assert.deepEqual(
  result.proposals.map((proposal) => proposal.toolName),
  [
    "say_nothing",
    "bash",
    "fetch_message",
    "read_image",
    "send_group_message",
    "send_dm",
    "send_image",
    "search_sticker",
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
    "executed",
    "executed",
    "skipped"
  ]
);

const fetchMessage = findCall("get_msg");
assert.deepEqual(fetchMessage.params, {
  message_id: 111
});
const fetchToolResult = result.connectorResults.find(
  (item) => item.proposal.toolName === "fetch_message"
);
assert.ok(fetchToolResult?.result?.data);
const fetchToolJson = JSON.stringify(fetchToolResult.result) ?? "";
assert.notEqual(fetchToolJson, "");
assert.match(fetchToolJson, /\[CQ:mface,/);
assert.match(fetchToolJson, /\[CQ:image,[^\]]*sub_type=1/);
assert.doesNotMatch(fetchToolJson, /"segments"/);
for (const secret of [
  "FETCH_EMOJI_SECRET",
  "FETCH_PACKAGE_SECRET",
  "FETCH_MFACE_KEY_SECRET",
  "FETCH_URL_SECRET",
  "FETCH_CUSTOM_FILE_SECRET",
  "FETCH_PATH_SECRET",
  "FETCH_CUSTOM_URL_SECRET"
]) {
  assert.match(
    fetchToolJson,
    new RegExp(secret),
    `fetch_message must preserve complete sticker CQ data: ${secret}`
  );
}

const readImage = findCall("get_image");
assert.deepEqual(readImage.params, {
  file: "cat.png"
});
const readImageToolResult = result.connectorResults.find(
  (item) => item.proposal.toolName === "read_image"
);
assert.deepEqual(readImageToolResult?.result?.data, {
  file: "/mock/onebot/image/cat.png",
  url: "https://images.example.test/cat.png",
  raw: {
    file: "/mock/onebot/image/cat.png",
    url: "https://images.example.test/cat.png"
  }
});
assert.deepEqual(readImageToolResult?.result?.media, {
  source: "connector-action",
  kind: "https-url",
  value: "https://images.example.test/cat.png"
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
assert.equal(sendMsgCalls.length, 1);

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

const stickerConnectorResults = result.connectorResults.filter(
  (item) =>
    item.proposal.toolName === "search_sticker" ||
    item.proposal.toolName === "send_sticker"
);
assert.deepEqual(
  stickerConnectorResults.map((item) => item.status),
  ["failed", "failed"],
  "sticker tools require the runtime sticker service rather than raw connector CQ input"
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
