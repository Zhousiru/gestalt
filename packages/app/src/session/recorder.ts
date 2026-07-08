import type { GestaltHome } from "../home/resolveGestaltHome";
import { createDailyJsonlWriter } from "../recording/dailyJsonl";
import {
  SessionSnapshotSchema,
  type SessionSnapshot
} from "./schemas";

export interface SessionRecorder {
  recordSnapshot(snapshot: SessionSnapshot): void;
  flush(): Promise<void>;
}

export function createSessionRecorder(home: GestaltHome): SessionRecorder {
  const writer = createDailyJsonlWriter(home.sessionsDir);
  let pendingWrite: Promise<void> = Promise.resolve();
  let writeError: unknown;

  return {
    recordSnapshot(snapshot) {
      const parsedSnapshot = SessionSnapshotSchema.parse(snapshot);
      pendingWrite = pendingWrite
        .then(() => writer.append(parsedSnapshot.exportedAt, parsedSnapshot))
        .catch((error: unknown) => {
          writeError = error;
        });
    },

    async flush() {
      await pendingWrite;
      if (writeError) {
        throw writeError;
      }
    }
  };
}
