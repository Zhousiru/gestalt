import { readFile } from "node:fs/promises";
import type { GestaltHome } from "./resolveGestaltHome";

export type GestaltConfigValue =
  | string
  | number
  | boolean
  | Array<string | number | boolean>;

export interface GestaltConfig {
  path: string;
  raw: string;
  flatValues: Record<string, GestaltConfigValue>;
}

export async function loadConfig(home: GestaltHome): Promise<GestaltConfig> {
  const raw = await readOptionalFile(home.configPath);

  return {
    path: home.configPath,
    raw,
    flatValues: parseFlatTomlValues(raw)
  };
}

async function readOptionalFile(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

function parseFlatTomlValues(raw: string): Record<string, GestaltConfigValue> {
  const values: Record<string, GestaltConfigValue> = {};

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("[")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    if (key) {
      values[key] = parseValue(value);
    }
  }

  return values;
}

function parseValue(value: string): GestaltConfigValue {
  const arrayValue = parseArrayValue(value);
  if (arrayValue !== undefined) {
    return arrayValue;
  }
  return parseScalarValue(value);
}

function parseArrayValue(
  value: string
): Array<string | number | boolean> | undefined {
  if (!value.startsWith("[") || !value.endsWith("]")) {
    return undefined;
  }

  const inner = value.slice(1, -1).trim();
  if (!inner) {
    return [];
  }

  return splitArrayItems(inner).map((item) => parseScalarValue(item.trim()));
}

function splitArrayItems(value: string): string[] {
  const items: string[] = [];
  let current = "";
  let inQuote = false;
  let escaped = false;

  for (const character of value) {
    if (character === "\"" && !escaped) {
      inQuote = !inQuote;
    }

    if (character === "," && !inQuote) {
      items.push(current);
      current = "";
      escaped = false;
      continue;
    }

    current += character;
    escaped = character === "\\" && inQuote && !escaped;
    if (character !== "\\" && escaped) {
      escaped = false;
    }
  }

  items.push(current);
  return items.filter((item) => item.trim().length > 0);
}

function parseScalarValue(value: string): string | number | boolean {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }

  const quoted = value.match(/^"(.*)"$/);
  if (quoted?.[1] !== undefined) {
    return quoted[1];
  }

  const numericValue = Number(value);
  if (Number.isFinite(numericValue) && value !== "") {
    return numericValue;
  }

  return value;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
