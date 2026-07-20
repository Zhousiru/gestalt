import { parse } from "smol-toml";
import { z, type ZodIssue } from "zod";

export type GestaltConfigValue =
  | string
  | number
  | boolean
  | Array<string | number | boolean>;

const nonEmptyString = z.string().trim().min(1);
const clearableString = z.string().transform((value) => value.trim());
const positiveInteger = z.number().int().positive();
const nonNegativeInteger = z.number().int().nonnegative();
const positiveNumber = z.number().finite().min(1);
const probability = z
  .number()
  .finite()
  .refine((value) => value >= 0 && value <= 1, {
    message: "must be between 0 and 1"
  });
const id = z.union([nonEmptyString, nonNegativeInteger]);
const toolChoice = z.union([
  z.enum(["required", "auto", "none"]),
  z.literal("")
]);
const promptCacheTtl = z.union([z.enum(["5m", "1h"]), z.literal("")]);
const routingSort = z.union([
  z.enum(["price", "throughput", "latency"]),
  z.literal("")
]);
const timezone = nonEmptyString.refine(isValidTimezone, {
  message: "must be a valid IANA timezone"
});
const regex = clearableString.refine(isValidRegex, {
  message: "must be a valid JavaScript regular expression"
});

function languageModelFields(
  prefix: "main_model" | "sub_model"
): Record<string, z.ZodType> {
  return {
    [`${prefix}_provider`]: nonEmptyString.optional(),
    [`${prefix}_base_url`]: nonEmptyString.optional(),
    [`${prefix}_name`]: nonEmptyString.optional(),
    [`${prefix}_api_key`]: nonEmptyString.optional(),
    [`${prefix}_api_key_env`]: nonEmptyString.optional(),
    [`${prefix}_temperature`]: z.number().finite().nonnegative().optional(),
    [`${prefix}_max_steps`]: positiveInteger.optional(),
    [`${prefix}_routing_order`]: clearableString.optional(),
    [`${prefix}_routing_allow_fallbacks`]: z.boolean().optional(),
    [`${prefix}_routing_sort`]: routingSort.optional(),
    [`${prefix}_thinking`]: clearableString.optional(),
    [`${prefix}_tool_choice`]: toolChoice.optional(),
    [`${prefix}_prompt_cache_enabled`]: z.boolean().optional(),
    [`${prefix}_prompt_cache_ttl`]: promptCacheTtl.optional()
  };
}

export const gestaltConfigSchema = z
  .strictObject({
    connector: z
      .enum(["mock", "onebot-forward-ws", "onebot-reverse-ws"])
      .optional(),
    allowedgroups: z.array(id).optional(),

    onebot_ws_url: nonEmptyString.optional(),
    onebot_host: nonEmptyString.optional(),
    onebot_port: positiveInteger.optional(),
    onebot_path: nonEmptyString.optional(),
    onebot_access_token_env: nonEmptyString.optional(),

    live_enabled: z.boolean().optional(),
    live_host: nonEmptyString.optional(),
    live_port: positiveInteger.optional(),

    ...languageModelFields("main_model"),
    ...languageModelFields("sub_model"),

    embedding_model_provider: nonEmptyString.optional(),
    embedding_model_base_url: nonEmptyString.optional(),
    embedding_model_name: nonEmptyString.optional(),
    embedding_model_id: nonEmptyString.optional(),
    embedding_model_api_key: nonEmptyString.optional(),
    embedding_model_api_key_env: nonEmptyString.optional(),
    embedding_model_dimensions: positiveInteger.optional(),
    embedding_model_routing_order: clearableString.optional(),
    embedding_model_routing_allow_fallbacks: z.boolean().optional(),

    sticker_scraping_enabled: z.boolean().optional(),
    sticker_processing_concurrency: z.number().int().min(1).max(32).optional(),
    sticker_recommendation_probability: probability.optional(),
    sticker_recommendation_limit: z.number().int().min(1).max(20).optional(),
    operator_user_ids: z.array(id).optional(),

    timezone: timezone.optional(),
    bot_user_id: nonEmptyString.optional(),
    bot_display_name: nonEmptyString.optional(),
    session_recent_history_hours: positiveInteger.optional(),
    context_recent_message_count: nonNegativeInteger.max(500).optional(),
    trace_binary_capture_enabled: z.boolean().optional(),
    dreaming_enabled: z.boolean().optional(),

    trigger_enabled: z.boolean().optional(),
    trigger_mention_enabled: z.boolean().optional(),
    trigger_mention_probability: probability.optional(),
    trigger_keyword_names: clearableString.optional(),
    trigger_keyword_regex: regex.optional(),
    trigger_keyword_probability: probability.optional(),
    trigger_activity_enabled: z.boolean().optional(),
    trigger_activity_probability: probability.optional(),
    trigger_activity_window_ms: positiveInteger.optional(),
    trigger_activity_min_messages: positiveInteger.optional(),
    trigger_icebreaker_enabled: z.boolean().optional(),
    trigger_icebreaker_probability: probability.optional(),
    trigger_icebreaker_quiet_ms: positiveInteger.optional(),

    agent_loop_aggregation_delay_ms: positiveInteger.optional(),
    agent_loop_aggregation_max_delay_ms: positiveInteger.optional(),
    agent_loop_aggregation_backoff_multiplier: positiveNumber.optional(),
    agent_loop_exit_say_nothing_enabled: z.boolean().optional(),
    agent_loop_exit_say_nothing_count: positiveInteger.optional(),
    agent_loop_exit_idle_enabled: z.boolean().optional(),
    agent_loop_exit_idle_ms: positiveInteger.optional()
  })
  .superRefine((config, context) => {
    for (const prefix of [
      "main_model",
      "sub_model",
      "embedding_model"
    ] as const) {
      const apiKey = `${prefix}_api_key` as keyof typeof config;
      const apiKeyEnv = `${prefix}_api_key_env` as keyof typeof config;
      if (config[apiKey] !== undefined && config[apiKeyEnv] !== undefined) {
        context.addIssue({
          code: "custom",
          path: [apiKey],
          message: `cannot be used together with ${String(apiKeyEnv)}`
        });
      }
    }
    const delay = config.agent_loop_aggregation_delay_ms;
    const maxDelay = config.agent_loop_aggregation_max_delay_ms;
    if (delay !== undefined && maxDelay !== undefined && maxDelay < delay) {
      context.addIssue({
        code: "custom",
        path: ["agent_loop_aggregation_max_delay_ms"],
        message:
          "must be greater than or equal to agent_loop_aggregation_delay_ms"
      });
    }
  });

export function parseGestaltConfig(
  raw: string,
  configPath = "config.toml"
): Record<string, GestaltConfigValue> {
  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch (error) {
    throw new Error(
      `Invalid TOML in ${configPath}: ${errorMessage(error)}`,
      { cause: error }
    );
  }

  const result = gestaltConfigSchema.safeParse(parsed);
  if (!result.success) {
    const details = result.error.issues.map(formatIssue).join("\n- ");
    throw new Error(`Invalid Gestalt config ${configPath}:\n- ${details}`);
  }

  return result.data as Record<string, GestaltConfigValue>;
}

function formatIssue(issue: ZodIssue): string {
  if (issue.code === "unrecognized_keys") {
    return `unknown key${issue.keys.length === 1 ? "" : "s"}: ${issue.keys.join(", ")}`;
  }
  const location = issue.path.length > 0 ? issue.path.join(".") : "config";
  return `${location}: ${issue.message}`;
}

function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function isValidRegex(value: string): boolean {
  if (!value) {
    return true;
  }
  try {
    new RegExp(value, "i");
    return true;
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
