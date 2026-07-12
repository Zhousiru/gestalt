import assert from "node:assert/strict";
import {
  createOneBotIngressQueue,
  type OneBotIngressFailure
} from "./ingressQueue";

let releaseBurst!: () => void;
const burstGate = new Promise<void>((resolve) => {
  releaseBurst = resolve;
});
const handled: number[] = [];
const failures: Array<OneBotIngressFailure<number>> = [];
let activeHandlers = 0;
let maxActiveHandlers = 0;

const queue = createOneBotIngressQueue<number>({
  concurrency: 3,
  capacity: 5,
  async handle(event) {
    activeHandlers += 1;
    maxActiveHandlers = Math.max(maxActiveHandlers, activeHandlers);
    try {
      await burstGate;
      handled.push(event);
    } finally {
      activeHandlers -= 1;
    }
  },
  onFailure(failure) {
    failures.push(failure);
  }
});

for (let event = 0; event < 8; event += 1) {
  assert.equal(queue.enqueue(event), true);
}
assert.equal(queue.enqueue(8), false);
assert.deepEqual(queue.getStats(), {
  active: 3,
  queued: 5,
  accepted: 8,
  completed: 0,
  failed: 0,
  rejected: 1
});
assert.equal(maxActiveHandlers, 0, "handlers start in a controlled microtask");

await Promise.resolve();
assert.equal(maxActiveHandlers, 3);
releaseBurst();
await queue.whenIdle();
assert.equal(maxActiveHandlers, 3);
assert.deepEqual(handled, [0, 1, 2, 3, 4, 5, 6, 7]);
assert.deepEqual(
  failures.map((failure) => failure.code),
  ["queue_overflow"]
);

const failureEvents: string[] = [];
const continued: string[] = [];
const failureQueue = createOneBotIngressQueue<string>({
  concurrency: 1,
  capacity: 2,
  async handle(event) {
    if (event === "bad") {
      throw new Error("expected handler failure");
    }
    continued.push(event);
  },
  async onFailure(failure) {
    failureEvents.push(failure.code);
    // A rejected diagnostic sink must also be contained by the queue.
    throw new Error("expected diagnostic failure");
  }
});

assert.equal(failureQueue.enqueue("bad"), true);
assert.equal(failureQueue.enqueue("after"), true);
await failureQueue.whenIdle();
await Promise.resolve();
assert.deepEqual(failureEvents, ["handler_failed"]);
assert.deepEqual(continued, ["after"]);
assert.deepEqual(failureQueue.getStats(), {
  active: 0,
  queued: 0,
  accepted: 2,
  completed: 1,
  failed: 1,
  rejected: 0
});

console.log(
  JSON.stringify({
    ok: true,
    maxActiveHandlers,
    accepted: queue.getStats().accepted,
    rejected: queue.getStats().rejected,
    failureContained: true
  })
);
