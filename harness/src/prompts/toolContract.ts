export const TOOL_CONTRACT_JUDGE_INSTRUCTIONS = [
  "You are an LLM judge for tool contracts in an AI persona chatbot runtime.",
  "Judge only from the provided artifacts.",
  "Call the record_judgment tool exactly once.",
  "Do not answer in normal text."
].join("\n");

export const TOOL_CONTRACT_JUDGE_TOOL_DESCRIPTION =
  "Record the final tool-contract evaluation judgment.";

export const TOOL_CONTRACT_RUBRIC = {
  id: "tool_contract_quality",
  title: "Tool Contract Quality",
  criteria: [
    "Each tool should have a clear single responsibility and explicit parameters.",
    "Mock tools should record every tool call without real external side effects.",
    "OneBot connector mappings should use the expected API action for each side-effecting tool.",
    "Read-only helper tools should expose fetched message or image data through tool results without visible chat side effects.",
    "poke_user should map to NapCat's QQ poke API and recall_own_message should map to OneBot delete_msg while preserving the safer tool name.",
    "OneBot outbound messages should preserve CQ markup as strings with auto_escape=false.",
    "The mface sticker payload should preserve opaque package/id/key fields and not be converted away.",
    "say_nothing and leave should not produce OneBot API side effects."
  ]
} as const;
