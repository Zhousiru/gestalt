export class TurnSteeredError extends Error {
  constructor(message = "Turn attempt was steered with newer context.") {
    super(message);
    this.name = "AbortError";
  }
}

export function isTurnSteeredError(error: unknown): boolean {
  return (
    error instanceof TurnSteeredError ||
    (error instanceof Error && error.name === "AbortError")
  );
}

export function throwIfTurnSteered(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new TurnSteeredError();
  }
}

export async function waitForTurnDelay(
  delayMs: number,
  signal?: AbortSignal
): Promise<void> {
  throwIfTurnSteered(signal);

  if (delayMs <= 0) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);

    function onAbort(): void {
      clearTimeout(timer);
      reject(new TurnSteeredError());
    }

    signal?.addEventListener("abort", onAbort, { once: true });
  });

  throwIfTurnSteered(signal);
}
