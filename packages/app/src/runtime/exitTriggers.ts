import type { Conversation } from "../events/schemas";
import type { GestaltConfig } from "../home/loadConfig";
import type { AgentTurnResult } from "./agentLoop";

export interface AgentLoopExitState {
  loopId: string;
  conversation: Conversation;
  startedAt: string;
  turnIds: string[];
  turnsCompleted: number;
  consecutiveSayNothing: number;
}

export type AgentLoopExitCause =
  | {
      type: "after_turn";
      result: AgentTurnResult;
    }
  | {
      type: "idle_timeout";
      idleMs: number;
      lastResult?: AgentTurnResult;
    };

export interface AgentLoopExitTriggerInput {
  config: GestaltConfig;
  state: AgentLoopExitState;
  cause: AgentLoopExitCause;
  now: () => Date;
}

export interface AgentLoopIdleTimeoutInput {
  config: GestaltConfig;
  state: AgentLoopExitState;
  now: () => Date;
}

export interface AgentLoopExitDecision {
  triggerName: string;
  reason: string;
  description?: string;
}

export interface AgentLoopExitTrigger {
  name: string;
  idleTimeoutMs?(
    input: AgentLoopIdleTimeoutInput
  ): number | undefined;
  evaluate(
    input: AgentLoopExitTriggerInput
  ): AgentLoopExitDecision | undefined;
}

interface AgentLoopExitOptions {
  sayNothingEnabled: boolean;
  sayNothingCount: number;
  idleEnabled: boolean;
  idleMs: number;
}

export function createDefaultAgentLoopExitTriggers(
  config: GestaltConfig
): AgentLoopExitTrigger[] {
  const options = readAgentLoopExitOptions(config);
  return [
    createLeaveToolExitTrigger(),
    createConsecutiveSayNothingExitTrigger(options),
    createIdleTimeoutExitTrigger(options)
  ].filter((trigger): trigger is AgentLoopExitTrigger => trigger !== undefined);
}

export function evaluateAgentLoopExitTriggers(
  triggers: AgentLoopExitTrigger[],
  input: AgentLoopExitTriggerInput
): AgentLoopExitDecision | undefined {
  for (const trigger of triggers) {
    const decision = trigger.evaluate(input);
    if (decision) {
      return decision;
    }
  }
  return undefined;
}

export function getNextAgentLoopIdleTimeoutMs(
  triggers: AgentLoopExitTrigger[],
  input: AgentLoopIdleTimeoutInput
): number | undefined {
  const values = triggers
    .map((trigger) => trigger.idleTimeoutMs?.(input))
    .filter((value): value is number => value !== undefined);
  if (values.length === 0) {
    return undefined;
  }
  return Math.min(...values);
}

function createLeaveToolExitTrigger(
): AgentLoopExitTrigger {
  return {
    name: "leave_tool",
    evaluate(input) {
      if (
        input.cause.type === "after_turn" &&
        input.cause.result.proposedActions.some(
          (action) => action.toolName === "leave"
        )
      ) {
        return {
          triggerName: "leave_tool",
          reason: "leave_tool",
          description: "The model selected the leave tool."
        };
      }
      return undefined;
    }
  };
}

function createConsecutiveSayNothingExitTrigger(
  options: AgentLoopExitOptions
): AgentLoopExitTrigger | undefined {
  if (!options.sayNothingEnabled) {
    return undefined;
  }

  return {
    name: "consecutive_say_nothing",
    evaluate(input) {
      if (
        input.cause.type === "after_turn" &&
        input.state.consecutiveSayNothing >= options.sayNothingCount
      ) {
        return {
          triggerName: "consecutive_say_nothing",
          reason: "consecutive_say_nothing",
          description: `The model selected say_nothing ${input.state.consecutiveSayNothing} consecutive times.`
        };
      }
      return undefined;
    }
  };
}

function createIdleTimeoutExitTrigger(
  options: AgentLoopExitOptions
): AgentLoopExitTrigger | undefined {
  if (!options.idleEnabled) {
    return undefined;
  }

  return {
    name: "idle_timeout",
    idleTimeoutMs() {
      return options.idleMs;
    },
    evaluate(input) {
      if (
        input.cause.type === "idle_timeout" &&
        input.cause.idleMs >= options.idleMs
      ) {
        return {
          triggerName: "idle_timeout",
          reason: "idle_timeout",
          description: `No new messages arrived for ${input.cause.idleMs}ms.`
        };
      }
      return undefined;
    }
  };
}

function readAgentLoopExitOptions(config: GestaltConfig): AgentLoopExitOptions {
  const flat = config.flatValues;
  return {
    sayNothingEnabled: readBoolean(
      flat,
      "agent_loop_exit_say_nothing_enabled",
      true
    ),
    sayNothingCount: readPositiveInteger(
      flat,
      "agent_loop_exit_say_nothing_count",
      3
    ),
    idleEnabled: readBoolean(flat, "agent_loop_exit_idle_enabled", true),
    idleMs: readPositiveInteger(
      flat,
      "agent_loop_exit_idle_ms",
      3 * 60 * 1000
    )
  };
}

function readBoolean(
  flat: GestaltConfig["flatValues"],
  key: string,
  fallback: boolean
): boolean {
  const value = flat[key];
  if (typeof value === "boolean") {
    return value;
  }
  if (value === undefined) {
    return fallback;
  }
  throw new Error(`Config value ${key} must be a boolean.`);
}

function readPositiveInteger(
  flat: GestaltConfig["flatValues"],
  key: string,
  fallback: number
): number {
  const value = flat[key];
  const numericValue =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : undefined;

  if (numericValue === undefined) {
    return fallback;
  }
  if (!Number.isInteger(numericValue) || numericValue <= 0) {
    throw new Error(`Config value ${key} must be a positive integer.`);
  }
  return numericValue;
}
