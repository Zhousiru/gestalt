import { watch, type FSWatcher } from "node:fs";
import type { GestaltHomeView } from "./types";

export interface HomeWatcher {
  close(): void;
}

export function watchGestaltHome(
  home: GestaltHomeView,
  onChange: (kind: "sessions" | "traces") => void
): HomeWatcher {
  const watchers: FSWatcher[] = [];
  let timer: NodeJS.Timeout | undefined;
  let pendingKind: "sessions" | "traces" = "sessions";

  const schedule = (kind: "sessions" | "traces") => {
    pendingKind = kind;
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = undefined;
      onChange(pendingKind);
    }, 250);
  };

  for (const [kind, directory] of [
    ["sessions", home.sessionsDir],
    ["traces", home.tracesDir]
  ] as const) {
    try {
      watchers.push(
        watch(directory, { persistent: false }, (_eventType, fileName) => {
          if (!fileName || String(fileName).endsWith(".jsonl")) {
            schedule(kind);
          }
        })
      );
    } catch {
      // Missing folders are common before the first runtime write.
    }
  }

  return {
    close() {
      if (timer) {
        clearTimeout(timer);
      }
      for (const watcher of watchers) {
        watcher.close();
      }
    }
  };
}
