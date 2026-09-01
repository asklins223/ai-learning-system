import type { SceneFrameBounds } from "./scene-input";

export type ScenePointerVisibilityTarget = EventTarget & {
  readonly visibilityState?: string;
};

export type ScenePointerRuntimeInput = Readonly<{
  readonly clientX: number;
  readonly clientY: number;
  readonly pointerType?: string;
  readonly frameBounds: SceneFrameBounds;
  readonly enabled: boolean;
}>;

export type ScenePointerRuntimeOptions = Readonly<{
  /** DOM element whose pointer lifecycle is observed; no event ownership is taken. */
  readonly target: HTMLElement;
  /** Caller-owned, preferably cached frame bounds; this runtime never measures layout. */
  readonly getFrameBounds: () => SceneFrameBounds | null | undefined;
  /** Presentation sink receiving one latest pointer snapshot per animation frame. */
  readonly onPointer: (input: ScenePointerRuntimeInput | null) => unknown;
  /** Motion policy gate. Disabled mode immediately submits a neutral pointer. */
  readonly enabled?: boolean;
  /** Injectable lifecycle targets for tests and non-window hosts. */
  readonly windowTarget?: EventTarget | null;
  readonly visibilityTarget?: ScenePointerVisibilityTarget | null;
  /** Injectable frame scheduler; production defaults to window.requestAnimationFrame. */
  readonly requestFrame?: (callback: () => void) => number;
  readonly cancelFrame?: (handle: number) => void;
}>;

export type ScenePointerRuntime = Readonly<{
  /** Re-submit the latest pointer after bounds or camera state changes. */
  readonly sync: () => void;
  /** Toggle the motion gate without losing the latest pointer position. */
  readonly setEnabled: (enabled: boolean) => void;
  /** Remove listeners, cancel the pending frame, and neutralize the sink. */
  readonly destroy: () => void;
}>;

type PointerSnapshot = Readonly<{
  readonly clientX: number;
  readonly clientY: number;
  readonly pointerType?: string;
}>;

type PointerSnapshotResult = PointerSnapshot | null | typeof IGNORE_POINTER;

const IGNORE_POINTER = Symbol("ignore-secondary-pointer");

function safeCall(action: () => void): void {
  try {
    action();
  } catch {
    // Pointer and lifecycle callbacks are presentation-only boundaries.
  }
}

function pointerSnapshotOf(event: Event): PointerSnapshotResult {
  try {
    const pointer = event as PointerEvent;
    if (pointer.isPrimary === false) return IGNORE_POINTER;
    if (!Number.isFinite(pointer.clientX) || !Number.isFinite(pointer.clientY)) return null;

    const pointerType = typeof pointer.pointerType === "string" && pointer.pointerType
      ? pointer.pointerType
      : undefined;
    if (pointerType && pointerType !== "mouse" && pointerType !== "pen") return null;

    return Object.freeze({
      clientX: pointer.clientX,
      clientY: pointer.clientY,
      pointerType,
    });
  } catch {
    return null;
  }
}

type ListenerRegistration = Readonly<{
  readonly target: EventTarget;
  readonly type: string;
  readonly handler: EventListener;
  readonly options?: AddEventListenerOptions;
}>;

function removeListener(registration: ListenerRegistration): void {
  safeCall(() => registration.target.removeEventListener(
    registration.type,
    registration.handler,
    registration.options,
  ));
}

/**
 * Forward non-owning DOM pointer state to a presentation sink.
 *
 * The runtime intentionally does not use pointer capture, preventDefault, or
 * propagation control. Pointer moves are coalesced to one submission per
 * animation frame; touch, invalid input, hidden windows, and disabled motion
 * stay neutral.
 */
export function createScenePointerRuntime(
  options: ScenePointerRuntimeOptions,
): ScenePointerRuntime {
  const windowTarget = options.windowTarget === undefined
    ? (typeof window === "undefined" ? null : window)
    : options.windowTarget;
  const visibilityTarget = options.visibilityTarget === undefined
    ? (typeof document === "undefined" ? null : document)
    : options.visibilityTarget;
  const requestFrame = options.requestFrame
    ?? (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function"
      ? (callback: () => void) => window.requestAnimationFrame(() => callback())
      : null);
  const cancelFrame = options.cancelFrame
    ?? (typeof window !== "undefined" && typeof window.cancelAnimationFrame === "function"
      ? (handle: number) => window.cancelAnimationFrame(handle)
      : null);

  let enabled = options.enabled !== false;
  let destroyed = false;
  let currentPointer: PointerSnapshot | null = null;
  let frameScheduled = false;
  let frameHandle: number | null = null;

  const submit = (input: ScenePointerRuntimeInput | null): void => {
    safeCall(() => options.onPointer(input));
  };

  const cancelScheduledFrame = (): void => {
    if (!frameScheduled) return;
    frameScheduled = false;
    const handle = frameHandle;
    frameHandle = null;
    if (handle !== null && cancelFrame) safeCall(() => cancelFrame(handle));
  };

  const submitNeutral = (): void => {
    cancelScheduledFrame();
    submit(null);
  };

  const clearPointer = (): void => {
    currentPointer = null;
    submitNeutral();
  };

  const flush = (): void => {
    if (destroyed) return;
    let visible = true;
    try {
      visible = visibilityTarget?.visibilityState !== "hidden";
    } catch {
      visible = false;
    }
    if (!visible) {
      currentPointer = null;
      submit(null);
      return;
    }
    if (!enabled || !currentPointer) {
      submit(null);
      return;
    }

    let frameBounds: SceneFrameBounds | null | undefined;
    try {
      frameBounds = options.getFrameBounds();
    } catch {
      frameBounds = null;
    }
    if (!frameBounds) {
      submit(null);
      return;
    }

    submit({
      clientX: currentPointer.clientX,
      clientY: currentPointer.clientY,
      frameBounds,
      enabled: true,
      pointerType: currentPointer.pointerType,
    });
  };

  const schedule = (): void => {
    if (destroyed || !enabled || !currentPointer || frameScheduled) return;
    frameScheduled = true;
    const run = () => {
      frameScheduled = false;
      frameHandle = null;
      flush();
    };

    if (!requestFrame) {
      run();
      return;
    }

    try {
      const handle = requestFrame(run);
      // A test or host scheduler may execute synchronously.
      if (frameScheduled) frameHandle = handle;
    } catch {
      frameScheduled = false;
      frameHandle = null;
      flush();
    }
  };

  const handlePointerMove: EventListener = (event) => {
    if (destroyed) return;
    try {
      if (visibilityTarget?.visibilityState === "hidden") {
        clearPointer();
        return;
      }
    } catch {
      clearPointer();
      return;
    }
    const snapshot = pointerSnapshotOf(event);
    if (snapshot === IGNORE_POINTER) return;
    if (!snapshot) {
      clearPointer();
      return;
    }
    currentPointer = snapshot;
    schedule();
  };
  const handlePointerReset: EventListener = () => {
    if (!destroyed) clearPointer();
  };
  const handleVisibilityChange: EventListener = () => {
    if (destroyed) return;
    try {
      if (visibilityTarget?.visibilityState === "hidden") clearPointer();
    } catch {
      clearPointer();
    }
  };

  const registrations: ListenerRegistration[] = [];
  const addListener = (
    target: EventTarget | null,
    type: string,
    handler: EventListener,
    listenerOptions?: AddEventListenerOptions,
  ): void => {
    if (!target) return;
    target.addEventListener(type, handler, listenerOptions);
    registrations.push({ target, type, handler, options: listenerOptions });
  };

  try {
    addListener(options.target, "pointermove", handlePointerMove, { passive: true });
    addListener(options.target, "pointerleave", handlePointerReset, { passive: true });
    addListener(options.target, "pointercancel", handlePointerReset, { passive: true });
    addListener(windowTarget, "blur", handlePointerReset, { passive: true });
    addListener(visibilityTarget, "visibilitychange", handleVisibilityChange, { passive: true });
  } catch (error) {
    for (const registration of registrations) removeListener(registration);
    throw error;
  }

  return {
    sync() {
      if (destroyed) return;
      try {
        if (visibilityTarget?.visibilityState === "hidden") {
          clearPointer();
          return;
        }
      } catch {
        clearPointer();
        return;
      }
      if (!enabled || !currentPointer) {
        submitNeutral();
        return;
      }
      schedule();
    },
    setEnabled(nextEnabled) {
      if (destroyed) return;
      enabled = nextEnabled;
      if (!enabled) submitNeutral();
      else schedule();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      cancelScheduledFrame();
      currentPointer = null;
      submit(null);
      for (const registration of registrations) removeListener(registration);
      registrations.length = 0;
    },
  };
}
