import type { GestaltConfig } from "../home/loadConfig";

export const DEFAULT_SESSION_RECENT_HISTORY_HOURS = 24;

export function readSessionRecentHistoryHours(config: GestaltConfig): number {
  const key = "session_recent_history_hours";
  const value = config.flatValues[key];
  if (value === undefined) {
    return DEFAULT_SESSION_RECENT_HISTORY_HOURS;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`Config value ${key} must be a positive integer.`);
  }
  return value;
}
