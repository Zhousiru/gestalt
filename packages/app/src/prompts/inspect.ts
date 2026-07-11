import { createRenderedPrompt } from "./hash";
import type { RenderedPrompt } from "./types";

export function renderInspectSystemPrompt(): RenderedPrompt {
  return createRenderedPrompt(
    "runtime.inspect.system",
    [
      "You are the inspect agent for a dev/debug chatbot runtime.",
      "Your job is to answer why a message, tool call, window, turn, or loop decision happened.",
      "You must ground the answer in session and trace evidence.",
      "You have a read-only bash tool with virtual filesystem mounts:",
      "- /sessions contains rotated realtime session snapshots as JSONL.",
      "- /traces contains rotated agent turn traces as JSONL.",
      "Do not attempt to modify files. The mounted evidence is read-only.",
      "Use bash to inspect the evidence before answering.",
      "Mention missing evidence explicitly instead of guessing.",
      "Keep the report concise and useful for an engineer.",
      "When you have enough evidence, call send_inspect_report with the final diagnosis.",
      "Do not finish in normal text. send_inspect_report is the only valid way to complete inspect.",
      "The report must be plain text only. Do not use Markdown formatting, bullet lists, tables, headings, code fences, or links."
    ].join("\n")
  );
}

export interface InspectTaskPromptInput {
  now: string;
  query: string;
  conversation: string;
  eventId: string;
  sessionSeq: number;
  messageId: string;
  sender: string;
  receivedAt: string;
  text: string;
  conversationSummary: string;
}

export function renderInspectTaskPrompt(
  input: InspectTaskPromptInput
): RenderedPrompt {
  return createRenderedPrompt(
    "runtime.inspect.task",
    [
      "Current time:",
      input.now,
      "",
      "User inspect request:",
      input.query || "(no explicit inspect query; diagnose the current conversation state)",
      "",
      "Current inspect command event:",
      `- conversation: ${input.conversation}`,
      `- event_id: ${input.eventId}`,
      `- session_seq: ${input.sessionSeq}`,
      `- message_id: ${input.messageId}`,
      `- sender: ${input.sender}`,
      `- received_at: ${input.receivedAt}`,
      `- text: ${input.text}`,
      "",
      "Current conversation snapshot summary:",
      input.conversationSummary,
      "",
      "Suggested first steps:",
      "- List /sessions and /traces.",
      "- Read the latest session JSONL line for the current conversation.",
      "- Find the relevant self message/action/turn if the request mentions one.",
      "- Use the turn traceId to inspect /traces when available.",
      "- Explain trigger/window reason, context events, proposed action reason, tool result, and loop exit if relevant.",
      "- Finish by calling send_inspect_report.",
      "- Final report style: plain text only, no Markdown."
    ].join("\n")
  );
}
