import type { GestaltConfig } from "./loadConfig";

export type AppConnector =
  | "mock"
  | "onebot-forward-ws"
  | "onebot-reverse-ws";

export interface AppHostConfig {
  connector: AppConnector;
  onebot: {
    wsUrl?: string;
    host?: string;
    port?: number;
    path?: string;
    accessToken?: string;
    accessTokenEnv?: string;
  };
  live: {
    enabled: boolean;
    host: string;
    port: number;
  };
}

export function resolveAppHostConfig(
  config: GestaltConfig,
  env: NodeJS.ProcessEnv = process.env
): AppHostConfig {
  const connector = readConnector(config);
  const accessTokenEnv = readOptionalString(config, "onebot_access_token_env");
  const accessToken = accessTokenEnv && connector !== "mock"
    ? readRequiredEnvironmentVariable(accessTokenEnv, env)
    : undefined;
  const wsUrl = readOptionalString(config, "onebot_ws_url");
  const host = readOptionalString(config, "onebot_host");
  const port = readOptionalPositiveInteger(config, "onebot_port");
  const onebotPath = readOptionalString(config, "onebot_path");
  const onebot = {
    ...(wsUrl ? { wsUrl } : {}),
    ...(host ? { host } : {}),
    ...(port ? { port } : {}),
    ...(onebotPath ? { path: onebotPath } : {}),
    ...(accessToken ? { accessToken } : {}),
    ...(accessTokenEnv ? { accessTokenEnv } : {})
  };

  if (connector === "onebot-forward-ws" && !onebot.wsUrl) {
    throw new Error(
      "Config value onebot_ws_url is required when connector is onebot-forward-ws."
    );
  }
  if (connector === "onebot-reverse-ws" && !onebot.port) {
    throw new Error(
      "Config value onebot_port is required when connector is onebot-reverse-ws."
    );
  }

  return {
    connector,
    onebot,
    live: {
      enabled: readBoolean(config, "live_enabled", false),
      host: readOptionalString(config, "live_host") ?? "127.0.0.1",
      port: readOptionalPositiveInteger(config, "live_port") ?? 3000
    }
  };
}

function readConnector(config: GestaltConfig): AppConnector {
  const value = readOptionalString(config, "connector") ?? "mock";
  if (
    value === "mock" ||
    value === "onebot-forward-ws" ||
    value === "onebot-reverse-ws"
  ) {
    return value;
  }
  throw new Error(
    "Config value connector must be mock, onebot-forward-ws, or onebot-reverse-ws."
  );
}

function readOptionalString(
  config: GestaltConfig,
  key: string
): string | undefined {
  const value = config.flatValues[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Config value ${key} must be a non-empty string.`);
  }
  return value.trim();
}

function readOptionalPositiveInteger(
  config: GestaltConfig,
  key: string
): number | undefined {
  const value = config.flatValues[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`Config value ${key} must be a positive integer.`);
  }
  return value;
}

function readBoolean(
  config: GestaltConfig,
  key: string,
  fallback: boolean
): boolean {
  const value = config.flatValues[key];
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    throw new Error(`Config value ${key} must be a boolean.`);
  }
  return value;
}

function readRequiredEnvironmentVariable(
  name: string,
  env: NodeJS.ProcessEnv
): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(
      `Environment variable ${name} configured by onebot_access_token_env is not set.`
    );
  }
  return value;
}
