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

/**
 * Give one nested operation a smaller budget than its parent handler.
 *
 * The child receives its own AbortSignal. A child timeout never aborts the
 * parent signal, leaving the handler enough time to persist a deterministic
 * fallback or a retryable state. Parent cancellation still propagates down.
 */
export async function runWithAbortBudget<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  parentSignal: AbortSignal | undefined,
  timeoutMs: number,
  onLateError?: (error: unknown) => void,
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let settledByDeadline = false;
  let rejectDeadline: ((reason: unknown) => void) | undefined;

  const task = Promise.resolve().then(() => operation(controller.signal));
  const deadline = new Promise<never>((_, reject) => {
    rejectDeadline = reject;
    timer = setTimeout(() => {
      settledByDeadline = true;
      const error = new HandlerTimeoutError(timeoutMs);
      reject(error);
      controller.abort(error);
    }, timeoutMs);
  });

  const onParentAbort = () => {
    settledByDeadline = true;
    const reason = parentSignal?.reason instanceof Error
      ? parentSignal.reason
      : new DOMException("parent operation aborted", "AbortError");
    rejectDeadline?.(reason);
    controller.abort(reason);
  };

  if (parentSignal?.aborted) {
    onParentAbort();
  } else {
    parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  }

  try {
    return await Promise.race([task, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
    parentSignal?.removeEventListener("abort", onParentAbort);
    if (settledByDeadline) {
      void task.catch((error) => onLateError?.(error));
    }
  }
}
