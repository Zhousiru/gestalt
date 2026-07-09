export class TurnSteeredError extends Error {
  constructor(message = "Turn attempt was steered with newer context.") {
    super(message);
    this.name = "AbortError";
  }
}

export class AgentLoopForceLeaveError extends Error {
  constructor(message = "Active loop was force-ended by /leave.") {
    super(message);
    this.name = "AbortError";
  }
}

export function isTurnSteeredError(error: unknown): boolean {
  return (
    error instanceof TurnSteeredError ||
    (error instanceof Error &&
      error.name === "AbortError" &&
      !(error instanceof AgentLoopForceLeaveError))
  );
}

export function isAgentLoopForceLeaveError(error: unknown): boolean {
  return error instanceof AgentLoopForceLeaveError;
}

export function readTurnAbortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof AgentLoopForceLeaveError) {
    return signal.reason;
  }
  return new TurnSteeredError();
}

export function throwIfTurnSteered(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw readTurnAbortError(signal);
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
      reject(readTurnAbortError(signal));
    }

    signal?.addEventListener("abort", onAbort, { once: true });
  });

  throwIfTurnSteered(signal);
}
