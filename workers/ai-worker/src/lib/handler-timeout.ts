export class HandlerTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`job timed out after ${timeoutMs}ms`);
    this.name = "HandlerTimeoutError";
  }
}

/**
 * Abort the operation when its deadline expires. The operation may still take
 * time to unwind, so callers must also fence persistent side effects with the
 * job lease associated with the same signal.
 */
export async function runWithAbortTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  onLateError?: (error: unknown) => void,
): Promise<T> {
  const controller = new AbortController();
  const task = Promise.resolve().then(() => operation(controller.signal));
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;

  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      const error = new HandlerTimeoutError(timeoutMs);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });

  try {
    return await Promise.race([task, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
    if (timedOut) {
      void task.catch((error) => onLateError?.(error));
    }
  }
}
