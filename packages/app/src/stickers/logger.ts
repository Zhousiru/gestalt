import { createDailyJsonlWriter } from "../recording/dailyJsonl";
import type { GestaltHome } from "../home/resolveGestaltHome";
import { sanitizeUntrustedValue } from "../privacy/stickerRedaction";
import {
  StickerLogEntrySchema,
  type StickerLogEntry
} from "./schemas";

export interface StickerLogger {
  append(entry: StickerLogEntry): Promise<void>;
}

export function createStickerLogger(home: GestaltHome): StickerLogger {
  const writer = createDailyJsonlWriter(home.stickerLogsDir);
  return {
    async append(entry) {
      const parsed = StickerLogEntrySchema.parse(
        sanitizeUntrustedValue(
          entry,
          { redactUrls: true }
        )
      );
      await writer.append(parsed.at, parsed);
    }
  };
}
