import type { Conversation } from "../events/schemas";
import type { GestaltConfig } from "../home/loadConfig";
import type {
  MessageWindowReason,
  SessionEventRecord
} from "../session/schemas";
import type { SessionStore } from "../session/store";

export interface TriggerEvaluationInput {
  config: GestaltConfig;
  sessionStore: SessionStore;
  record: SessionEventRecord;
  now: () => Date;
}

export interface TriggerDecision {
  triggerName: string;
  reason: MessageWindowReason;
  conversation: Conversation;
  fromSeq: number;
  toSeq: number;
  description?: string;
}

export interface GroupTrigger {
  name: string;
  evaluate(input: TriggerEvaluationInput): TriggerDecision | undefined;
}

export function evaluateGroupTriggers(
  triggers: GroupTrigger[],
  input: TriggerEvaluationInput
): TriggerDecision | undefined {
  for (const trigger of triggers) {
    const decision = trigger.evaluate(input);
    if (decision) {
      return decision;
    }
  }
  return undefined;
}
