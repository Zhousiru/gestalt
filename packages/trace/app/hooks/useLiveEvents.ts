import { LiveEventEnvelopeSchema, type LiveEventEnvelope } from "@gestalt/live-contracts";
import { useEffect, useRef, useState } from "react";

export type LiveConnectionState = "connecting" | "live" | "offline";

export function useLiveEvents(
  onEvent: (event: LiveEventEnvelope) => void
): LiveConnectionState {
  const callbackRef = useRef(onEvent);
  const [state, setState] = useState<LiveConnectionState>("connecting");
  callbackRef.current = onEvent;

  useEffect(() => {
    const source = new EventSource("/api/live/events");
    const receive = (raw: Event) => {
      if (!(raw instanceof MessageEvent)) return;
      try {
        const parsed = LiveEventEnvelopeSchema.safeParse(JSON.parse(String(raw.data)));
        if (!parsed.success) return;
        setState("live");
        callbackRef.current(parsed.data);
      } catch {
        // A malformed diagnostic event must not take down the live connection.
      }
    };

    source.onopen = () => setState("live");
    source.onmessage = receive;
    source.addEventListener("live", receive);
    source.onerror = () => setState("offline");

    return () => source.close();
  }, []);

  return state;
}
