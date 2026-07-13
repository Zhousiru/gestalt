import { readFile } from "node:fs/promises";
import type { GestaltHome } from "./resolveGestaltHome";
import {
  parseGestaltConfig,
  type GestaltConfigValue
} from "./configSchema";

export type { GestaltConfigValue } from "./configSchema";

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
    flatValues: parseGestaltConfig(raw, home.configPath)
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

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
