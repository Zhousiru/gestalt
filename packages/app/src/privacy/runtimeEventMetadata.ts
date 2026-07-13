/**
 * Connector transport trees are never retained. Runtime-created self events
 * may preserve only these small, non-secret correlation fields.
 */
export function readSafeRuntimeEventRaw(
  event: Record<string, unknown>,
  value: unknown
): Record<string, string> | undefined {
  const source = readRecord(event.source);
  const sender = readRecord(event.sender);
  const raw = readRecord(value);
  if (!source || !sender || !raw || sender.isSelf !== true) {
    return undefined;
  }

  switch (source.connector) {
    case "runtime-self": {
      const stickerId = readString(raw.stickerId);
      if (raw.generatedBy !== "send_sticker" || !stickerId) {
        return undefined;
      }
      return { generatedBy: "send_sticker", stickerId };
    }
    case "runtime-inspect": {
      const requestEventId = readString(raw.requestEventId);
      const requestMessageId = readString(raw.requestMessageId);
      if (
        raw.generatedBy !== "inspect" ||
        !requestEventId ||
        !requestMessageId
      ) {
        return undefined;
      }
      return {
        generatedBy: "inspect",
        requestEventId,
        requestMessageId
      };
    }
    case "runtime-control": {
      const requestEventId = readString(raw.requestEventId);
      if (raw.generatedBy !== "runtime-control" || !requestEventId) {
        return undefined;
      }
      return { generatedBy: "runtime-control", requestEventId };
    }
    default:
      return undefined;
  }
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}
