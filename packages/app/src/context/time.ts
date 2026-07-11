import type { GestaltConfig } from "../home/loadConfig";

export type TimezoneSource = "config" | "system" | "utc_fallback";

export interface ResolvedTimezone {
  timezone: string;
  source: TimezoneSource;
}

export interface ZonedDateTime {
  date: string;
  time: string;
  weekday: string;
  offset: string;
}

export function resolveTimezone(
  config: GestaltConfig,
  readSystemTimezone: () => string | undefined = () =>
    Intl.DateTimeFormat().resolvedOptions().timeZone
): ResolvedTimezone {
  const configured = config.flatValues.timezone;
  if (configured !== undefined) {
    if (typeof configured !== "string" || !configured.trim()) {
      throw new Error("Config value timezone must be a non-empty IANA timezone.");
    }
    const timezone = configured.trim();
    assertValidTimezone(timezone, "configured");
    return { timezone, source: "config" };
  }

  const systemTimezone = readSystemTimezone()?.trim();
  if (systemTimezone && isValidTimezone(systemTimezone)) {
    return { timezone: systemTimezone, source: "system" };
  }

  return { timezone: "UTC", source: "utc_fallback" };
}

export function formatZonedDateTime(
  date: Date,
  timezone: string
): ZonedDateTime {
  if (Number.isNaN(date.valueOf())) {
    throw new Error("Cannot format an invalid date.");
  }

  const parts = readDateParts(date, timezone);
  const localTimestamp = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );
  const offsetMinutes = Math.round((localTimestamp - date.valueOf()) / 60_000);

  return {
    date: `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}`,
    time: `${pad(parts.hour)}:${pad(parts.minute)}`,
    weekday: parts.weekday,
    offset: formatUtcOffset(offsetMinutes)
  };
}

export function renderCurrentEnvironment(
  now: Date,
  timezone: string
): string {
  const current = formatZonedDateTime(now, timezone);
  return [
    "Current environment:",
    `- Current local time: ${current.date} ${current.time}`,
    `- Day of week: ${current.weekday}`,
    `- Timezone: ${timezone} (${current.offset})`
  ].join("\n");
}

function readDateParts(
  date: Date,
  timezone: string
): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: string;
} {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });
  const parts = new Map(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );

  return {
    year: readNumericPart(parts, "year"),
    month: readNumericPart(parts, "month"),
    day: readNumericPart(parts, "day"),
    hour: readNumericPart(parts, "hour"),
    minute: readNumericPart(parts, "minute"),
    second: readNumericPart(parts, "second"),
    weekday: parts.get("weekday") ?? "Unknown"
  };
}

function formatUtcOffset(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? "-" : "+";
  const absolute = Math.abs(offsetMinutes);
  return `UTC${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}

function readNumericPart(parts: ReadonlyMap<string, string>, key: string): number {
  const value = Number(parts.get(key));
  if (!Number.isInteger(value)) {
    throw new Error(`Intl formatter did not return a valid ${key}.`);
  }
  return value;
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, "0");
}

function assertValidTimezone(timezone: string, source: string): void {
  if (!isValidTimezone(timezone)) {
    throw new Error(`Invalid ${source} IANA timezone "${timezone}".`);
  }
}

function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}
