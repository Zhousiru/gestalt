import assert from "node:assert/strict";
import { createLiveEventBus } from "./eventBus";
import { createLiveRunStore } from "./runStore";

const now = () => new Date("2026-07-12T12:00:00.000Z");

{
  const bus = createLiveEventBus({
    now,
    maxBufferedEvents: 3,
    maxBufferedBytes: 700,
    maxEventBytes: 180
  });
  bus.publish("agent.run.started", {
    traceId: "rollout-1",
    conversationKey: "group:g1",
    startedAt: now().toISOString(),
    eventRecords: [{ raw: Buffer.alloc(256 * 1024, 1) }]
  });
  bus.publish("agent.run.failed", {
    traceId: "rollout-1",
    error: "x".repeat(10_000)
  });
  bus.publish("session.event.appended", {
    conversationKey: "group:g1",
    eventId: "event-1"
  });
  bus.publish("session.event.appended", {
    conversationKey: "group:g1",
    eventId: "event-2"
  });

  const events = bus.getRecentEvents();
  assert.ok(events.length <= 3);
  assert.ok(
    events.reduce(
      (bytes, event) => bytes + Buffer.byteLength(JSON.stringify(event)),
      0
    ) <= 700
  );
  const serialized = JSON.stringify(events);
  assert.equal(serialized.includes("Buffer"), false);
  assert.equal(serialized.includes("xxxxxxxxxx"), false);
  assert.equal(serialized.includes("live_event_payload_limit"), true);
}

{
  const bus = createLiveEventBus({ now });
  let delivered = "";
  bus.subscribe({
    onEvent(event) {
      delivered = JSON.stringify(event);
    }
  });
  bus.publish("agent.run.failed", {
    traceId: "rollout-cq-binary",
    error:
      "failed [CQ:reply,id=42] [CQ:image,file=base64://QUJDRA==] " +
      "[CQ:image,file=data:image/png;base64,RUZHSA==]"
  });
  assert.equal(delivered.includes("base64://"), false);
  assert.equal(delivered.includes("data:image/png;base64"), false);
  assert.equal(delivered.includes("QUJDRA=="), false);
  assert.equal(delivered.includes("RUZHSA=="), false);
  assert.equal(delivered.includes("[CQ:reply,id=42]"), true);
  assert.equal(delivered.includes("[表情数据]"), true);
}

{
  const bus = createLiveEventBus({ now });
  for (let index = 0; index < 600; index += 1) {
    bus.publish("session.event.appended", {
      conversationKey: "group:g1",
      eventId: `event-${index}`
    });
  }
  assert.equal(bus.getRecentEvents().length, 500);

  let healthySubscriberEvents = 0;
  bus.subscribe({
    onEvent() {
      throw new Error("fixture subscriber failed");
    }
  });
  bus.subscribe({
    onEvent() {
      healthySubscriberEvents += 1;
    }
  });
  assert.doesNotThrow(() => bus.publish("agent.run.failed", {}));
  assert.equal(healthySubscriberEvents, 1);
}

{
  const bus = createLiveEventBus({ now });
  const runs = createLiveRunStore(bus);
  bus.publish("agent.run.started", {
    traceId: "rollout-active",
    conversationKey: "group:g1",
    eventId: "event-1",
    startedAt: now().toISOString(),
    eventRecords: [{}]
  });
  assert.equal(runs.getActiveRuns().length, 1);
  bus.publish("rollout.recorded", {
    rolloutId: "rollout-active",
    conversationKey: "group:g1",
    status: "completed"
  });
  assert.equal(runs.getActiveRuns().length, 0);
  runs.dispose();
}
