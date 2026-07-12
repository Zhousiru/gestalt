import type {
  ModelClient,
  ModelExchangeSink,
  ModelExchangeSnapshot as RuntimeModelExchangeSnapshot,
  ModelRequestSnapshot,
  ModelResponseSnapshot
} from "@gestalt/app";

export type ModelExchangePurpose = "agent_action" | "dreaming";

export interface ModelExchangeSnapshot {
  exchangeId: string;
  purpose: ModelExchangePurpose;
  request: ModelRequestSnapshot;
  response?: ModelResponseSnapshot;
  status: RuntimeModelExchangeSnapshot["status"];
  startedAt?: string;
  endedAt?: string;
}

export interface ModelExchangeCapture {
  readonly exchanges: ModelExchangeSnapshot[];
  wrap(model: ModelClient): ModelClient;
  notifyRequestStarted(): void;
  waitForRequestCount(count: number, timeoutMs?: number): Promise<void>;
}

export function createModelExchangeCapture(): ModelExchangeCapture {
  const exchanges: ModelExchangeSnapshot[] = [];
  let startedRequestCount = 0;
  const requestWaiters = new Set<RequestCountWaiter>();

  return {
    exchanges,
    wrap(model) {
      return {
        ...(model.name ? { name: model.name } : {}),
        createSession(options = {}) {
          return model.createSession({
            exchangeSink: mergeExchangeSinks(
              options.exchangeSink,
              createCaptureSink(exchanges)
            )
          });
        }
      };
    },
    notifyRequestStarted() {
      startedRequestCount += 1;
      for (const waiter of requestWaiters) {
        if (startedRequestCount < waiter.count) {
          continue;
        }
        clearTimeout(waiter.timeout);
        requestWaiters.delete(waiter);
        waiter.resolve();
      }
    },
    waitForRequestCount(count, timeoutMs = 30_000) {
      if (startedRequestCount >= count) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve, reject) => {
        const waiter: RequestCountWaiter = {
          count,
          resolve,
          timeout: setTimeout(() => {
            requestWaiters.delete(waiter);
            reject(
              new Error(
                `Timed out waiting for model request ${count}; observed ${startedRequestCount}.`
              )
            );
          }, timeoutMs)
        };
        requestWaiters.add(waiter);
      });
    }
  };
}

interface RequestCountWaiter {
  count: number;
  resolve(): void;
  timeout: ReturnType<typeof setTimeout>;
}

function createCaptureSink(
  exchanges: ModelExchangeSnapshot[]
): ModelExchangeSink {
  return {
    onStepStarted() {},
    onStepCompleted(exchange) {
      exchanges.push(toCapturedExchange(exchange));
    }
  };
}

function mergeExchangeSinks(
  first: ModelExchangeSink | undefined,
  second: ModelExchangeSink
): ModelExchangeSink {
  return {
    async onStepStarted(exchange) {
      await first?.onStepStarted(exchange);
      await second.onStepStarted(exchange);
    },
    async onStepCompleted(exchange) {
      await first?.onStepCompleted(exchange);
      await second.onStepCompleted(exchange);
    },
    async flush() {
      await first?.flush?.();
      await second.flush?.();
    }
  };
}

function toCapturedExchange(
  exchange: RuntimeModelExchangeSnapshot
): ModelExchangeSnapshot {
  if (!Array.isArray(exchange.request.messages)) {
    throw new Error(
      "Harness capture sink received a model request without canonical messages."
    );
  }
  return {
    exchangeId: exchange.exchangeId,
    purpose: exchange.purpose,
    request: exchange.request as ModelRequestSnapshot,
    ...(exchange.response
      ? { response: exchange.response as ModelResponseSnapshot }
      : {}),
    status: exchange.status,
    ...(exchange.startedAt ? { startedAt: exchange.startedAt } : {}),
    ...(exchange.endedAt ? { endedAt: exchange.endedAt } : {})
  };
}
