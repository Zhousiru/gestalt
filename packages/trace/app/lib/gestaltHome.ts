import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import type { GestaltHomeView } from "./types";

export function resolveGestaltHome(): GestaltHomeView {
  const base = process.env.INIT_CWD ?? process.cwd();
  const configured =
    readCliOption("--home") ?? process.env.GESTALT_HOME ?? findNearestGestaltHome(base);
  const root = path.resolve(base, configured);
  return {
    root,
    sessionsDir: path.join(root, "sessions"),
    tracesDir: path.join(root, "traces")
  };
}

function readCliOption(name: string): string | undefined {
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === name) {
      return args[index + 1];
    }
    if (arg?.startsWith(`${name}=`)) {
      return arg.slice(name.length + 1);
    }
  }
  return undefined;
}

function findNearestGestaltHome(start: string): string {
  let current = path.resolve(start);
  while (true) {
    const candidate = path.join(current, ".gestalt");
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return path.join(start, ".gestalt");
    }
    current = parent;
  }
}
