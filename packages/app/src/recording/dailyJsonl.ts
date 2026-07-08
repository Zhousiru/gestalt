import path from "node:path";
import { appendFile, mkdir } from "node:fs/promises";

export interface DailyJsonlWriter {
  append(timestamp: string, value: unknown): Promise<void>;
}

export function createDailyJsonlWriter(directory: string): DailyJsonlWriter {
  return {
    async append(timestamp, value) {
      await mkdir(directory, { recursive: true });
      const fileName = `${timestamp.slice(0, 10)}.jsonl`;
      const filePath = path.join(directory, fileName);
      await appendFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
    }
  };
}
