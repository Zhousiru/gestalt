import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { JsonlEntry } from "./types";

export async function readJsonlDirectory<T>(directory: string): Promise<JsonlEntry<T>[]> {
  const exists = await pathExists(directory);
  if (!exists) {
    return [];
  }

  const fileNames = (await readdir(directory))
    .filter((fileName) => fileName.endsWith(".jsonl"))
    .sort();
  const entries: JsonlEntry<T>[] = [];

  for (const fileName of fileNames) {
    const filePath = path.join(directory, fileName);
    const raw = await readFile(filePath, "utf8");
    const lines = raw.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]?.trim();
      if (!line) {
        continue;
      }
      try {
        entries.push({
          filePath,
          fileName,
          line: index + 1,
          value: JSON.parse(line) as T
        });
      } catch {
        // Corrupt partial writes can happen while tailing; ignore until next read.
      }
    }
  }

  return entries;
}

export async function listJsonlFileNames(directory: string): Promise<string[]> {
  const exists = await pathExists(directory);
  if (!exists) {
    return [];
  }
  return (await readdir(directory))
    .filter((fileName) => fileName.endsWith(".jsonl"))
    .sort();
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}
