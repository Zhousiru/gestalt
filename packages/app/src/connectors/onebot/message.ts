import {
  type OneBotMessage,
  type OneBotMessageSegment,
  OneBotMessageSegmentSchema
} from "./schemas";

export function normalizeOneBotMessageSegments(
  message: OneBotMessage
): OneBotMessageSegment[] {
  if (typeof message === "string") {
    return parseCqMessage(message);
  }
  if (Array.isArray(message)) {
    return message.map((segment) => OneBotMessageSegmentSchema.parse(segment));
  }
  return [OneBotMessageSegmentSchema.parse(message)];
}

export function renderOneBotMessageMarkup(
  segments: OneBotMessageSegment[]
): string {
  return segments.map(renderOneBotSegmentMarkup).join("");
}

export function hasOneBotMentionTarget(
  segments: OneBotMessageSegment[],
  targetId: string
): boolean {
  return segments.some(
    (segment) =>
      segment.type === "at" && readString(segment.data.qq) === targetId
  );
}

export function findOneBotReplyMessageId(
  segments: OneBotMessageSegment[]
): string | undefined {
  const reply = segments.find((segment) => segment.type === "reply");
  return reply ? readOptionalString(reply.data.id) : undefined;
}

export function createOneBotSendMessage(input: {
  text: string;
}): OneBotMessage {
  return input.text;
}

export function renderCqCode(
  type: string,
  data: Record<string, unknown> = {}
): string {
  return `[CQ:${type}${renderCqParams(data)}]`;
}

export function escapeCqText(value: string): string {
  return encodeCqText(value);
}

export function escapeCqParamValue(value: string): string {
  return encodeCqParamValue(value);
}

function renderOneBotSegmentMarkup(segment: OneBotMessageSegment): string {
  if (segment.type === "text") {
    return encodeCqText(readString(segment.data.text));
  }

  return renderCqCode(segment.type, segment.data);
}

function renderCqParams(data: Record<string, unknown>): string {
  const params = Object.entries(data)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${encodeCqParamValue(readString(value))}`);

  return params.length > 0 ? `,${params.join(",")}` : "";
}

function parseCqMessage(message: string): OneBotMessageSegment[] {
  const segments: OneBotMessageSegment[] = [];
  const pattern = /\[CQ:([A-Za-z0-9_-]+)((?:,[^\]]*)?)\]/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(message)) !== null) {
    if (match.index > cursor) {
      segments.push({
        type: "text",
        data: {
          text: decodeCqText(message.slice(cursor, match.index))
        }
      });
    }
    segments.push({
      type: match[1] ?? "unknown",
      data: parseCqParams(match[2] ?? "")
    });
    cursor = match.index + match[0].length;
  }

  if (cursor < message.length) {
    segments.push({
      type: "text",
      data: {
        text: decodeCqText(message.slice(cursor))
      }
    });
  }

  return segments.length > 0
    ? segments
    : [
        {
          type: "text",
          data: {
            text: message
          }
        }
      ];
}

function parseCqParams(raw: string): Record<string, string> {
  const params: Record<string, string> = {};
  const body = raw.startsWith(",") ? raw.slice(1) : raw;
  if (!body) {
    return params;
  }

  for (const part of body.split(",")) {
    const separator = part.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    params[part.slice(0, separator)] = decodeCqText(
      part.slice(separator + 1)
    );
  }
  return params;
}

function encodeCqText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/\[/g, "&#91;")
    .replace(/\]/g, "&#93;");
}

function encodeCqParamValue(value: string): string {
  return encodeCqText(value).replace(/,/g, "&#44;");
}

function decodeCqText(value: string): string {
  return value
    .replace(/&#91;/g, "[")
    .replace(/&#93;/g, "]")
    .replace(/&#44;/g, ",")
    .replace(/&amp;/g, "&");
}

function readString(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  return String(value);
}

function readOptionalString(value: unknown): string | undefined {
  const text = readString(value);
  return text ? text : undefined;
}
