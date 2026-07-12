export const DEFAULT_ONEBOT_INGRESS_CONCURRENCY = 8;
export const DEFAULT_ONEBOT_INGRESS_QUEUE_CAPACITY = 256;

export type OneBotIngressFailureCode = "handler_failed" | "queue_overflow";

export interface OneBotIngressFailure<T> {
  code: OneBotIngressFailureCode;
  error: Error;
  event: T;
}

export interface OneBotIngressQueueStats {
  active: number;
  queued: number;
  accepted: number;
  completed: number;
  failed: number;
  rejected: number;
}

export interface CreateOneBotIngressQueueOptions<T> {
  handle(event: T): void | Promise<void>;
  onFailure?(failure: OneBotIngressFailure<T>): void | Promise<void>;
  concurrency?: number;
  capacity?: number;
}

export interface OneBotIngressQueue<T> {
  /**
   * Returns false when the bounded queue is full. The event is not accepted,
   * and `onFailure` receives a queue_overflow diagnostic.
   */
  enqueue(event: T): boolean;
  getStats(): OneBotIngressQueueStats;
  whenIdle(): Promise<void>;
}

/**
 * A bounded executor for WebSocket events. WebSocket callbacks cannot apply
 * promise backpressure to `ws`, so overload is explicit instead of building an
 * unbounded promise chain. Action responses bypass this queue in transport.ts.
 */
export function createOneBotIngressQueue<T>(
  options: CreateOneBotIngressQueueOptions<T>
): OneBotIngressQueue<T> {
  const concurrency = readPositiveInteger(
    options.concurrency ?? DEFAULT_ONEBOT_INGRESS_CONCURRENCY,
    "OneBot ingress concurrency"
  );
  const capacity = readPositiveInteger(
    options.capacity ?? DEFAULT_ONEBOT_INGRESS_QUEUE_CAPACITY,
    "OneBot ingress queue capacity"
  );
  const queued: Array<{ event: T }> = [];
  const idleWaiters = new Set<() => void>();
  let active = 0;
  let accepted = 0;
  let completed = 0;
  let failed = 0;
  let rejected = 0;

  return {
    enqueue(event) {
      if (active >= concurrency && queued.length >= capacity) {
        rejected += 1;
        reportFailure({
          code: "queue_overflow",
          error: new Error(
            `OneBot ingress queue is full (${capacity} queued, ${concurrency} active).`
          ),
          event
        });
        return false;
      }

      accepted += 1;
      if (active < concurrency) {
        start(event);
      } else {
        queued.push({ event });
      }
      return true;
    },

    getStats() {
      return {
        active,
        queued: queued.length,
        accepted,
        completed,
        failed,
        rejected
      };
    },

    whenIdle() {
      if (active === 0 && queued.length === 0) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        idleWaiters.add(resolve);
      });
    }
  };

  function start(event: T): void {
    active += 1;
    void Promise.resolve()
      .then(() => options.handle(event))
      .then(
        () => {
          completed += 1;
        },
        (error: unknown) => {
          failed += 1;
          reportFailure({
            code: "handler_failed",
            error: toError(error),
            event
          });
        }
      )
      .finally(() => {
        active -= 1;
        drain();
      });
  }

  function drain(): void {
    while (active < concurrency && queued.length > 0) {
      const next = queued.shift();
      if (next) {
        start(next.event);
      }
    }
    if (active !== 0 || queued.length !== 0) {
      return;
    }
    const waiters = Array.from(idleWaiters);
    idleWaiters.clear();
    for (const resolve of waiters) {
      resolve();
    }
  }

  function reportFailure(failure: OneBotIngressFailure<T>): void {
    if (!options.onFailure) {
      return;
    }
    try {
      void Promise.resolve(options.onFailure(failure)).catch(() => undefined);
    } catch {
      // Diagnostics must not create a second unhandled ingress failure.
    }
  }
}

function readPositiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
