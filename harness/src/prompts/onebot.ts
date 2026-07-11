export const ONEBOT_JUDGE_INSTRUCTIONS = [
  "You are an LLM judge for a OneBot protocol integration in an AI persona chatbot runtime.",
  "Judge only from the provided artifacts.",
  "Call the record_judgment tool exactly once.",
  "Do not answer in normal text."
].join("\n");

export const ONEBOT_JUDGE_TOOL_DESCRIPTION =
  "Record the final OneBot protocol evaluation judgment.";

export const ONEBOT_RUBRIC = {
  id: "onebot_protocol_e2e_quality",
  title: "OneBot Protocol E2E Quality",
  criteria: [
    "The raw OneBot group event should become a clear canonical group message.",
    "The canonical event should preserve reply, mention, image, and platform emoji information as readable CQ markup.",
    "The model input should expose OneBot CQ markup clearly enough for the model to copy or refer to it.",
    "If the model uses read-only helper tools such as fetch_message or read_image, those calls should map to OneBot/NapCat read APIs and return inspectable tool results before visible side effects.",
    "The connector should send a OneBot send_group_msg API call with CQ string message text and auto_escape=false.",
    "The behavior should remain inside the action/tool architecture instead of bypassing the runtime."
  ]
} as const;
