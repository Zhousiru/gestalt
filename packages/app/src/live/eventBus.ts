import type {
  LiveEventSink,
  RuntimeLiveEventEnvelope,
  RuntimeLiveEventType
} from "./viewTypes";

export interface LiveEventBus extends LiveEventSink {
  subscribe(input: {
    lastEventId?: number;
    onEvent: (event: RuntimeLiveEventEnvelope) => void;
  }): () => void;
  getRecentEvents(): RuntimeLiveEventEnvelope[];
}

export interface CreateLiveEventBusOptions {
  maxBufferedEvents?: number;
  now?: () => Date;
}

export function createLiveEventBus(
  options: CreateLiveEventBusOptions = {}
): LiveEventBus {
  const maxBufferedEvents = options.maxBufferedEvents ?? 500;
  const now = options.now ?? (() => new Date());
  const subscribers = new Set<(event: RuntimeLiveEventEnvelope) => void>();
  const recentEvents: RuntimeLiveEventEnvelope[] = [];
  let nextId = 1;

  return {
    publish(type, data, at = now().toISOString()) {
      const event: RuntimeLiveEventEnvelope = {
        id: nextId,
        type: type as RuntimeLiveEventType,
        at,
        data
      };
      nextId += 1;
      recentEvents.push(event);
      while (recentEvents.length > maxBufferedEvents) {
        recentEvents.shift();
      }
      for (const subscriber of subscribers) {
        subscriber(event);
      }
      return event as RuntimeLiveEventEnvelope<typeof data>;
    },

    subscribe(input) {
      if (input.lastEventId !== undefined) {
        for (const event of recentEvents) {
          if (event.id > input.lastEventId) {
            input.onEvent(event);
          }
        }
      }
      subscribers.add(input.onEvent);
      return () => {
        subscribers.delete(input.onEvent);
      };
    },

    getRecentEvents() {
      return [...recentEvents];
    }
  };
}
