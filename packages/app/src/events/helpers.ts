import type { CanonicalEvent } from "./schemas";

export function isSelfMessageEvent(event: CanonicalEvent): boolean {
  if (event.type !== "MessageReceived") {
    return false;
  }
  return (
    event.sender.isSelf === true ||
    (event.source.accountId !== undefined &&
      event.sender.id === event.source.accountId)
  );
}
