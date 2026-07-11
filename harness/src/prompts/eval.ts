export interface EvalRubric {
  id: string;
  title: string;
  prompt: string;
  criteria: string[];
}

export const DEFAULT_EVAL_FIXTURES = [
  "harness/fixtures/scenarios/group-chat-loop-steer.json",
  "harness/fixtures/scenarios/group-context-history.json",
  "harness/fixtures/scenarios/model-e2e.json",
  "harness/fixtures/scenarios/multi-step-agent-tools.json",
  "harness/fixtures/scenarios/memory-injection-dreaming.json"
] as const;

export const RUBRICS_BY_SCENARIO: Record<string, EvalRubric[]> = {
  "group-chat-loop-steer": [{
    id: "group_steer_quality",
    title: "Group Steer Quality",
    prompt: "Judge whether the final action reflects the steered group-chat context rather than only the first message.",
    criteria: ["The final model response should account for both the original mention and the later steering message.", "The bot should avoid duplicate or conflicting replies.", "The trace/session should show one coherent completed turn with a clear steer.", "The action should be socially plausible for a compact group-chat reply."]
  }],
  "group-context-history": [{
    id: "group_context_history_quality",
    title: "Group Context History Quality",
    prompt: "Judge whether the compiled group context contains the right history, reply target, self-message labeling, and participant memories.",
    criteria: ["The model input should include the current window message and configurable recent history.", "The reply target older than the recent-history window should still be expanded into the transcript.", "Prior bot messages should be present with a clear self-message label.", "Messages outside the configured recent-history count should be absent.", "Participant index memories should cover everyone represented in the carried context, not stop at a fixed small cap."]
  }],
  "model-e2e": [{
    id: "direct_reply_quality",
    title: "Direct Reply Quality",
    prompt: "Judge whether the model made a reasonable visible action for a direct mention.",
    criteria: ["The model should understand that a message marked 'mentioned you' directly addressed it.", "The selected tool should match the user request.", "The reply should be concise and natural.", "The output should remain inside an action tool call without extra prose."]
  }],
  "multi-step-agent-tools": [{
    id: "multi_step_agent_tool_quality",
    title: "Multi-Step Agent Tool Quality",
    prompt: "Judge whether the main agent behaves like a multi-step tool-using agent in one turn.",
    criteria: ["The model should execute react_to_message before send_group_message in the same turn.", "The model should receive or record the first tool result before continuing to the second tool.", "The model should choose leave after the requested visible work is complete.", "The exported session should preserve the complete proposed action and tool result sequence.", "The trace should make every tool call inspectable under the normal model/tool runtime path.", "The final group reply should satisfy the user request without duplicate visible replies."]
  }],
  "memory-injection-dreaming": [{
    id: "memory_dreaming_quality",
    title: "Memory Dreaming Quality",
    prompt: "Judge whether the memory dreaming pass wrote useful concrete memory through the bash tool.",
    criteria: ["The model should inspect relevant memory before writing.", "The model should use bash tool calls rather than plain text commands.", "Memory updates should be concrete, useful, and not placeholder text.", "Self memory and Alice memory should be written to the correct areas.", "Commands should stay inside /memories."]
  }]
};

export const GENERAL_JUDGE_INSTRUCTIONS = [
  "You are an LLM judge for an AI persona chatbot runtime.",
  "Judge behavior from the provided replay artifacts and rubric.",
  "This is not a unit test. Most cases are qualitative.",
  "Use concrete evidence from the artifacts.",
  "Call the record_judgment tool exactly once.",
  "Do not answer in normal text."
].join("\n");

export const GENERAL_JUDGE_TOOL_DESCRIPTION =
  "Record the final LLM judge result for this replay artifact.";

export function renderJudgePrompt(input: {
  scenarioId: string;
  rubricTitle: string;
  prompt: string;
  criteria: string[];
  evidence: unknown;
}): string {
  return [
    `Scenario: ${input.scenarioId}`,
    `Rubric: ${input.rubricTitle}`,
    "",
    "Task:",
    input.prompt,
    "",
    "Criteria:",
    input.criteria.map((criterion) => `- ${criterion}`).join("\n"),
    "",
    "Evidence JSON:",
    JSON.stringify(input.evidence, null, 2)
  ].join("\n");
}
