import path from "node:path";
import { existsSync } from "node:fs";
import { config as loadDotenvFile } from "dotenv";
import type { GestaltHome } from "./resolveGestaltHome";

export interface LoadedEnvFile {
  path: string;
  keys: string[];
}

export interface LoadEnvOptions {
  cwd?: string;
  override?: boolean;
}

export function loadEnv(
  home: GestaltHome,
  options: LoadEnvOptions = {}
): LoadedEnvFile[] {
  const cwd = options.cwd ?? process.env.INIT_CWD ?? process.cwd();
  const override = options.override ?? false;
  const loaded: LoadedEnvFile[] = [];

  for (const filePath of getEnvFileCandidates(cwd, home.root)) {
    if (!existsSync(filePath)) {
      continue;
    }

    const result = loadDotenvFile({
      path: filePath,
      override,
      quiet: true
    });

    if (result.error) {
      throw result.error;
    }

    loaded.push({
      path: filePath,
      keys: Object.keys(result.parsed ?? {})
    });
  }

  return loaded;
}

function getEnvFileCandidates(cwd: string, homeRoot: string): string[] {
  const candidates = [
    path.join(cwd, ".env"),
    path.join(cwd, ".env.local"),
    path.join(homeRoot, ".env"),
    path.join(homeRoot, ".env.local")
  ];

  return Array.from(new Set(candidates));
}
