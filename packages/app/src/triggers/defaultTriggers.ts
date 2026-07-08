import type { MessageReceivedEvent } from "../events/schemas";
import { isSelfMessageEvent } from "../events/helpers";
import type { GestaltConfig } from "../home/loadConfig";
import type { SessionEventRecord } from "../session/schemas";
import type {
  GroupTrigger,
  TriggerDecision,
  TriggerEvaluationInput
} from "./types";

interface GroupTriggerOptions {
  enabled: boolean;
  mentionEnabled: boolean;
  keywordNames: string[];
  keywordRegex?: RegExp;
  activityEnabled: boolean;
  activityWindowMs: number;
  activityMinMessages: number;
  icebreakerEnabled: boolean;
  icebreakerQuietMs: number;
}

export function createDefaultGroupTriggers(
  config: GestaltConfig
): GroupTrigger[] {
  const options = readGroupTriggerOptions(config);
  if (!options.enabled) {
    return [];
  }

  return [
    createMentionKeywordTrigger(options),
    createActivityTrigger(options),
    createIcebreakerTrigger(options)
  ].filter((trigger): trigger is GroupTrigger => trigger !== undefined);
}

function createMentionKeywordTrigger(
  options: GroupTriggerOptions
): GroupTrigger | undefined {
  if (
    !options.mentionEnabled &&
    options.keywordNames.length === 0 &&
    !options.keywordRegex
  ) {
    return undefined;
  }

  return {
    name: "mention_or_keyword",
    evaluate(input) {
      const event = getGroupMessageEvent(input.record);
      if (!event) {
        return undefined;
      }

      if (options.mentionEnabled && event.message.mentionsBot) {
        return createDecision(input.record, "mention_or_keyword", "mention");
      }

      if (matchesKeyword(event.message.text, options)) {
        return createDecision(input.record, "mention_or_keyword", "keyword");
      }

      return undefined;
    }
  };
}

function createActivityTrigger(
  options: GroupTriggerOptions
): GroupTrigger | undefined {
  if (!options.activityEnabled) {
    return undefined;
  }

  return {
    name: "group_activity",
    evaluate(input) {
      const event = getGroupMessageEvent(input.record);
      if (!event) {
        return undefined;
      }

      const currentTime = Date.parse(input.record.receivedAt);
      if (!Number.isFinite(currentTime)) {
        return undefined;
      }

      const cutoff = currentTime - options.activityWindowMs;
      const recentRecords = input.sessionStore
        .getEvents(event.conversation)
        .filter((record) => {
          if (record.seq > input.record.seq) {
            return false;
          }
          if (!getGroupMessageEvent(record)) {
            return false;
          }
          const receivedAt = Date.parse(record.receivedAt);
          return Number.isFinite(receivedAt) && receivedAt >= cutoff;
        });

      const previousCount = recentRecords.filter(
        (record) => record.seq < input.record.seq
      ).length;
      if (
        previousCount <= options.activityMinMessages &&
        recentRecords.length > options.activityMinMessages
      ) {
        const firstRecord = recentRecords[0];
        if (!firstRecord) {
          return undefined;
        }
        return {
          triggerName: "group_activity",
          reason: "activity",
          conversation: event.conversation,
          fromSeq: firstRecord.seq,
          toSeq: input.record.seq,
          description: `More than ${options.activityMinMessages} messages within ${options.activityWindowMs}ms.`
        };
      }

      return undefined;
    }
  };
}

function createIcebreakerTrigger(
  options: GroupTriggerOptions
): GroupTrigger | undefined {
  if (!options.icebreakerEnabled) {
    return undefined;
  }

  return {
    name: "icebreaker",
    evaluate(input) {
      const event = getGroupMessageEvent(input.record);
      if (!event) {
        return undefined;
      }

      const currentTime = Date.parse(input.record.receivedAt);
      if (!Number.isFinite(currentTime)) {
        return undefined;
      }

      const previousRecord = input.sessionStore
        .getEvents(event.conversation)
        .filter(
          (record) =>
            record.seq < input.record.seq && getGroupMessageEvent(record)
        )
        .at(-1);
      if (!previousRecord) {
        return undefined;
      }

      const previousTime = Date.parse(previousRecord.receivedAt);
      if (!Number.isFinite(previousTime)) {
        return undefined;
      }

      if (currentTime - previousTime >= options.icebreakerQuietMs) {
        return {
          triggerName: "icebreaker",
          reason: "icebreaker",
          conversation: event.conversation,
          fromSeq: input.record.seq,
          toSeq: input.record.seq,
          description: `Conversation was quiet for at least ${options.icebreakerQuietMs}ms.`
        };
      }

      return undefined;
    }
  };
}

function createDecision(
  record: SessionEventRecord,
  triggerName: string,
  reason: TriggerDecision["reason"]
): TriggerDecision | undefined {
  const event = getGroupMessageEvent(record);
  if (!event) {
    return undefined;
  }

  return {
    triggerName,
    reason,
    conversation: event.conversation,
    fromSeq: record.seq,
    toSeq: record.seq
  };
}

function getGroupMessageEvent(
  record: SessionEventRecord
): MessageReceivedEvent | undefined {
  const event = record.event;
  if (
    event.type !== "MessageReceived" ||
    event.conversation.kind !== "group" ||
    isSelfMessageEvent(event)
  ) {
    return undefined;
  }
  return event;
}

function matchesKeyword(text: string, options: GroupTriggerOptions): boolean {
  const normalizedText = text.toLocaleLowerCase();
  if (
    options.keywordNames.some((name) =>
      normalizedText.includes(name.toLocaleLowerCase())
    )
  ) {
    return true;
  }
  return options.keywordRegex?.test(text) ?? false;
}

function readGroupTriggerOptions(config: GestaltConfig): GroupTriggerOptions {
  const flat = config.flatValues;
  const keywordRegex = readRegex(flat, "trigger_keyword_regex");
  return {
    enabled: readBoolean(flat, "trigger_enabled", true),
    mentionEnabled: readBoolean(flat, "trigger_mention_enabled", true),
    keywordNames: readStringList(flat, "trigger_keyword_names"),
    activityEnabled: readBoolean(flat, "trigger_activity_enabled", true),
    activityWindowMs: readPositiveInteger(
      flat,
      "trigger_activity_window_ms",
      10 * 60 * 1000
    ),
    activityMinMessages: readPositiveInteger(
      flat,
      "trigger_activity_min_messages",
      5
    ),
    icebreakerEnabled: readBoolean(flat, "trigger_icebreaker_enabled", true),
    icebreakerQuietMs: readPositiveInteger(
      flat,
      "trigger_icebreaker_quiet_ms",
      60 * 60 * 1000
    ),
    ...(keywordRegex ? { keywordRegex } : {})
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

function readStringList(
  flat: GestaltConfig["flatValues"],
  key: string
): string[] {
  const value = flat[key];
  if (value === undefined) {
    return [];
  }
  if (typeof value !== "string") {
    throw new Error(`Config value ${key} must be a comma-separated string.`);
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function readRegex(
  flat: GestaltConfig["flatValues"],
  key: string
): RegExp | undefined {
  const value = flat[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`Config value ${key} must be a string regex.`);
  }
  if (!value.trim()) {
    return undefined;
  }
  return new RegExp(value, "i");
}
