import path from "node:path";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import type { GestaltHome } from "../home/resolveGestaltHome";

export interface PersonaFragment {
  name: string;
  relativePath: string;
  content: string;
  order: number;
}

export interface PersonaPack {
  homeRoot: string;
  version: string;
  fragments: PersonaFragment[];
}

const supportedExtensions = new Set([".md", ".markdown", ".jsonl", ".txt"]);

export async function loadPersona(home: GestaltHome): Promise<PersonaPack> {
  let entries;
  try {
    entries = await readdir(home.personaDir, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return emptyPersona(home.root);
    }
    throw error;
  }

  const files = entries
    .filter((entry) => entry.isFile())
    .filter((entry) => supportedExtensions.has(path.extname(entry.name)))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  const fragments = await Promise.all(
    files.map(async (fileName, index) => {
      const absolutePath = path.join(home.personaDir, fileName);
      const content = await readFile(absolutePath, "utf8");
      return {
        name: fileName,
        relativePath: path.relative(home.root, absolutePath).replace(/\\/g, "/"),
        content,
        order: index
      };
    })
  );

  return {
    homeRoot: home.root,
    version: hashPersonaFragments(fragments),
    fragments
  };
}

function emptyPersona(homeRoot: string): PersonaPack {
  return {
    homeRoot,
    version: "empty",
    fragments: []
  };
}

function hashPersonaFragments(fragments: PersonaFragment[]): string {
  const hash = createHash("sha256");
  for (const fragment of fragments) {
    hash.update(fragment.relativePath);
    hash.update("\0");
    hash.update(fragment.content);
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
