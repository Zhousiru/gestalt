import assert from "node:assert/strict";
import { createMockConnector } from "../connectors/mock/connector";
import { ConnectorOutcomeUnknownError } from "../connectors/types";
import type { ActionProposal } from "./schemas";
import { executeActions } from "./executeActions";

let dispatches = 0;
const connector = createMockConnector();
connector.sendGroupMessage = async () => {
  dispatches += 1;
  throw new ConnectorOutcomeUnknownError(
    "OneBot connection closed after the action was dispatched."
  );
};
const proposals: ActionProposal[] = [
  outboundProposal("unknown-1", "first"),
  outboundProposal("must-not-run", "second")
];
const starts: string[] = [];
const ends: string[] = [];
const results = await executeActions({
  connector,
  proposals,
  now: () => new Date("2026-07-13T09:00:00.000Z"),
  onExecutionStart(proposal) {
    starts.push(proposal.id);
  },
  onExecutionEnd(proposal) {
    ends.push(proposal.id);
  }
});

assert.equal(dispatches, 1);
assert.deepEqual(starts, ["unknown-1"]);
assert.deepEqual(ends, ["unknown-1"]);
assert.equal(results.length, 1);
assert.equal(results[0]?.status, "result_unknown");
assert.match(results[0]?.reason ?? "", /Do not retry/i);

function outboundProposal(id: string, text: string): ActionProposal {
  return {
    id,
    proposedAt: "2026-07-13T09:00:00.000Z",
    toolName: "send_group_message",
    params: { groupId: "group-1", text }
  };
}
