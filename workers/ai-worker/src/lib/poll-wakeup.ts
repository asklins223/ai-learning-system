/**
 * A bounded poll delay that can be interrupted by an external wake signal.
 *
 * The queue listener is only a hint, but a hint must wake an already sleeping
 * poll loop. Keeping the timer and resolver together also avoids stacking
 * overlapping timers when several NOTIFY messages arrive in one interval.
 */
export interface PollWakeSignal {
  wake(): void;
  wait(delayMs: number): Promise<void>;
}

export function createPollWakeSignal(): PollWakeSignal {
  let pendingWake = false;
  let resolveWait: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const finishWait = (): void => {
    const resolve = resolveWait;
    resolveWait = null;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    pendingWake = false;
    resolve?.();
  };

  return {
    wake(): void {
      pendingWake = true;
      if (resolveWait !== null) finishWait();
    },

    wait(delayMs: number): Promise<void> {
      if (pendingWake) {
        pendingWake = false;
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        resolveWait = resolve;
        timer = setTimeout(finishWait, Math.max(0, delayMs));
      });
    },
  };
}
