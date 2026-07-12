import type { MessageReceivedEvent } from "../events/schemas";
import type { StickerObservation, StickerSourceKind } from "./schemas";

export interface IgnoredStickerSegment {
  segmentIndex: number;
  reason:
    | "ordinary_image"
    | "image_missing_sticker_sub_type"
    | "unsupported_image_sub_type";
}

export function extractStickerObservations(
  event: MessageReceivedEvent
): StickerObservation[] {
  if (event.sender.isSelf || event.message.sourceContent?.format !== "onebot-v11") {
    return [];
  }

  return event.message.sourceContent.segments.flatMap((segment, segmentIndex) => {
    const sourceKind = classifyStickerSegment(segment);
    if (!sourceKind) {
      return [];
    }
    return [
      {
        sourceKind,
        eventId: event.id,
        messageId: event.message.id,
        conversation: event.conversation,
        senderId: event.sender.id,
        occurredAt: event.occurredAt,
        segmentIndex,
        segment
      }
    ];
  });
}

export function extractIgnoredStickerSegments(
  event: MessageReceivedEvent
): IgnoredStickerSegment[] {
  if (event.sender.isSelf || event.message.sourceContent?.format !== "onebot-v11") {
    return [];
  }
  return event.message.sourceContent.segments.flatMap((segment, segmentIndex) => {
    if (segment.type !== "image" || classifyStickerSegment(segment)) {
      return [];
    }
    const subType = segment.data.sub_type;
    return [
      {
        segmentIndex,
        reason:
          subType === undefined
            ? "image_missing_sticker_sub_type"
            : Number(subType) === 0
              ? "ordinary_image"
              : "unsupported_image_sub_type"
      }
    ];
  });
}

export function classifyStickerSegment(segment: {
  type: string;
  data: Record<string, unknown>;
}): StickerSourceKind | undefined {
  if (segment.type === "mface") {
    return "mface";
  }
  if (segment.type !== "image") {
    return undefined;
  }

  const data = segment.data;
  if (
    readString(data.file) === "marketface" ||
    data.emoji_id !== undefined ||
    data.emoji_package_id !== undefined ||
    data.key !== undefined
  ) {
    return "mface";
  }
  return Number(data.sub_type) === 1 ? "image" : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
