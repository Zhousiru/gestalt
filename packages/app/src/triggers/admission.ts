import { createHash } from "node:crypto";
import type { GestaltConfig } from "../home/loadConfig";
import type { SessionEventRecord } from "../session/schemas";
import type { TriggerDecision } from "./types";

export const TRIGGER_ADMISSION_SAMPLER_VERSION = "sha256-53-v1";

const DEFAULT_TRIGGER_PROBABILITY = 1;
const SAMPLE_DENOMINATOR = 2 ** 53;
const DEFAULT_TRIGGER_KINDS = [
  "mention",
  "keyword",
  "activity",
  "icebreaker"
] as const satisfies readonly TriggerDecision["reason"][];

export interface TriggerAdmissionDecision {
  probability: number;
  sample: number;
  admitted: boolean;
  samplerVersion: string;
}

export function evaluateTriggerAdmission(
  config: GestaltConfig,
  record: SessionEventRecord,
  decision: TriggerDecision
): TriggerAdmissionDecision {
  const probability = readTriggerProbability(config, decision.reason);
  const sample = sampleTriggerCandidate(record, decision);
  return {
    probability,
    sample,
    admitted: sample < probability,
    samplerVersion: TRIGGER_ADMISSION_SAMPLER_VERSION
  };
}

export function readTriggerProbability(
  config: GestaltConfig,
  triggerKind: TriggerDecision["reason"]
): number {
  const key = `trigger_${triggerKind}_probability`;
  const value = config.flatValues[key];
  if (value === undefined) {
    return DEFAULT_TRIGGER_PROBABILITY;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Config value ${key} must be a number between 0 and 1.`);
  }
  if (value < 0 || value > 1) {
    throw new Error(`Config value ${key} must be between 0 and 1.`);
  }
  return value;
}

export function validateDefaultTriggerProbabilities(
  config: GestaltConfig
): void {
  for (const triggerKind of DEFAULT_TRIGGER_KINDS) {
    readTriggerProbability(config, triggerKind);
  }
}

export function sampleTriggerCandidate(
  record: SessionEventRecord,
  decision: TriggerDecision
): number {
  const digest = createHash("sha256")
    .update(
      [
        TRIGGER_ADMISSION_SAMPLER_VERSION,
        `${decision.conversation.kind}:${decision.conversation.id}`,
        getStableEventIdentity(record),
        decision.reason
      ].join("\0")
    )
    .digest();
  const sampleBits = digest.readBigUInt64BE(0) >> 11n;
  return Number(sampleBits) / SAMPLE_DENOMINATOR;
}

function getStableEventIdentity(record: SessionEventRecord): string {
  if (record.event.type === "MessageReceived") {
    return `message:${record.event.message.id}`;
  }
  return `event:${record.event.id}`;
}
