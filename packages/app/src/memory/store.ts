import { readFile } from "node:fs/promises";
import path from "node:path";
import type { CanonicalEvent } from "../events/schemas";
import { isSelfMessageEvent } from "../events/helpers";
import type { GestaltHome } from "../home/resolveGestaltHome";
import type { SessionEventRecord } from "../session/schemas";

export interface MemoryFragment {
  id: string;
  source: "file";
  scope: "self" | "user";
  userId?: string;
  relativePath: string;
  content: string;
}

export interface MemoryQuery {
  event: CanonicalEvent;
  windowEvents?: SessionEventRecord[];
  limit?: number;
}

export interface MemoryStore {
  findRelevantMemories(query: MemoryQuery): Promise<MemoryFragment[]>;
}

export function createFileMemoryStore(home: GestaltHome): MemoryStore {
  return {
    async findRelevantMemories(query) {
      const fragments: MemoryFragment[] = [];

      const selfMemory = await readMemoryFile(home, "self/index.md", {
        id: "self:index",
        scope: "self"
      });
      if (selfMemory) {
        fragments.push(selfMemory);
      }

      for (const userId of getParticipantUserIds(query)) {
        const relativePath = `users/${getMemoryUserPathSegment(userId)}/index.md`;
        const userMemory = await readMemoryFile(home, relativePath, {
          id: `user:${userId}:index`,
          scope: "user",
          userId
        });
        if (userMemory) {
          fragments.push(userMemory);
        }
      }

      return fragments.slice(0, query.limit ?? fragments.length);
    }
  };
}

export function getMemoryUserPathSegment(userId: string): string {
  if (/^[A-Za-z0-9._-]+$/.test(userId)) {
    return userId;
  }
  return encodeURIComponent(userId);
}

function getParticipantUserIds(query: MemoryQuery): string[] {
  const ids: string[] = [];
  for (const record of query.windowEvents ?? []) {
    if (
      record.event.type === "MessageReceived" &&
      !isSelfMessageEvent(record.event)
    ) {
      ids.push(record.event.sender.id);
    }
  }

  if (query.event.type === "MessageReceived" && !isSelfMessageEvent(query.event)) {
    ids.push(query.event.sender.id);
  }

  return Array.from(new Set(ids));
}

async function readMemoryFile(
  home: GestaltHome,
  relativePath: string,
  metadata: Pick<MemoryFragment, "id" | "scope" | "userId">
): Promise<MemoryFragment | undefined> {
  try {
    const content = await readFile(
      path.join(home.memoriesDir, relativePath),
      "utf8"
    );
    const fragment: MemoryFragment = {
      id: metadata.id,
      source: "file",
      scope: metadata.scope,
      relativePath,
      content
    };
    if (metadata.userId !== undefined) {
      fragment.userId = metadata.userId;
    }
    return fragment;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
