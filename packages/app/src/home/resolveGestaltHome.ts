import path from "node:path";
import { mkdir } from "node:fs/promises";

export interface GestaltHome {
  root: string;
  configPath: string;
  personaDir: string;
  memoriesDir: string;
  sessionsDir: string;
  tracesDir: string;
  logsDir: string;
  toolCacheDir: string;
}

export interface ResolveGestaltHomeOptions {
  homePath?: string;
  cwd?: string;
  create?: boolean;
}

export async function resolveGestaltHome(
  options: ResolveGestaltHomeOptions = {}
): Promise<GestaltHome> {
  const cwd = options.cwd ?? process.env.INIT_CWD ?? process.cwd();
  const requestedHome = options.homePath ?? process.env.GESTALT_HOME ?? ".gestalt";
  const root = path.resolve(cwd, requestedHome);
  const home: GestaltHome = {
    root,
    configPath: path.join(root, "config.toml"),
    personaDir: path.join(root, "persona"),
    memoriesDir: path.join(root, "memories"),
    sessionsDir: path.join(root, "sessions"),
    tracesDir: path.join(root, "traces"),
    logsDir: path.join(root, "logs"),
    toolCacheDir: path.join(root, "tool-cache")
  };

  if (options.create !== false) {
    await Promise.all([
      mkdir(home.root, { recursive: true }),
      mkdir(home.personaDir, { recursive: true }),
      mkdir(home.memoriesDir, { recursive: true }),
      mkdir(home.sessionsDir, { recursive: true }),
      mkdir(home.tracesDir, { recursive: true }),
      mkdir(home.logsDir, { recursive: true }),
      mkdir(home.toolCacheDir, { recursive: true })
    ]);
  }

  return home;
}
