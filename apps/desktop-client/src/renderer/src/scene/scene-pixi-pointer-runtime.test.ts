import { describe, expect, it, vi } from "vitest";
import {
  createScenePixiPointerRuntime,
  type ScenePixiPointerRuntimeOptions,
} from "./scene-pixi-pointer-runtime";

type FakeEventTarget = {
  readonly listeners: Map<string, EventListenerOrEventListenerObject>;
  readonly addEventListener: ReturnType<typeof vi.fn>;
  readonly removeEventListener: ReturnType<typeof vi.fn>;
  dispatch(type: string, event: Event): void;
};

function createEventTarget(): FakeEventTarget {
  const listeners = new Map<string, EventListenerOrEventListenerObject>();
  const target = {
    listeners,
    addEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
      listeners.set(type, listener);
    }),
    removeEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
      if (listeners.get(type) === listener) listeners.delete(type);
    }),
    dispatch(type: string, event: Event) {
      const listener = listeners.get(type);
      if (typeof listener === "function") listener(event);
      else listener?.handleEvent(event);
    },
  };
  return target;
}

function pointerEvent(
  clientX: number,
  clientY: number,
  pointerType = "mouse",
  isPrimary = true,
): Event {
  return { clientX, clientY, pointerType, isPrimary } as unknown as Event;
}

function createRuntime(overrides: Partial<ScenePixiPointerRuntimeOptions> = {}) {
  const target = createEventTarget();
  const windowTarget = createEventTarget();
  const visibilityTarget = Object.assign(createEventTarget(), { visibilityState: "visible" });
  const frameBounds = { left: 20, top: 30, width: 800, height: 450 };
  const onPointer = vi.fn();
  let pendingFrame: (() => void) | null = null;
  const requestFrame = vi.fn((callback: () => void) => {
    pendingFrame = callback;
    return 7;
  });
  const cancelFrame = vi.fn(() => {
    pendingFrame = null;
  });
  const options: ScenePixiPointerRuntimeOptions = {
    target: target as unknown as HTMLElement,
    windowTarget: windowTarget as unknown as EventTarget,
    visibilityTarget: visibilityTarget as unknown as NonNullable<ScenePixiPointerRuntimeOptions["visibilityTarget"]>,
    getFrameBounds: () => frameBounds,
    onPointer,
    requestFrame,
    cancelFrame,
    ...overrides,
  };
  const runtime = createScenePixiPointerRuntime(options);
  return {
    target,
    windowTarget,
    visibilityTarget,
    frameBounds,
    onPointer,
    requestFrame,
    cancelFrame,
    flush() {
      const callback = pendingFrame;
      pendingFrame = null;
      callback?.();
    },
    runtime,
  };
}

describe("scene Pixi pointer runtime", () => {
  it("coalesces pointer moves and forwards the latest cached frame input", () => {
    const harness = createRuntime();
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();

    harness.target.dispatch("pointermove", {
      ...pointerEvent(120, 140),
      preventDefault,
      stopPropagation,
    } as unknown as Event);
    harness.target.dispatch("pointermove", pointerEvent(180, 220));

    expect(harness.requestFrame).toHaveBeenCalledOnce();
    expect(harness.onPointer).not.toHaveBeenCalled();
    harness.flush();

    expect(harness.onPointer).toHaveBeenCalledOnce();
    expect(harness.onPointer).toHaveBeenLastCalledWith({
      clientX: 180,
      clientY: 220,
      frameBounds: harness.frameBounds,
      enabled: true,
      pointerType: "mouse",
    });
    expect(preventDefault).not.toHaveBeenCalled();
    expect(stopPropagation).not.toHaveBeenCalled();
    harness.runtime.destroy();
  });

  it("resets immediately when disabled, then replays the latest pointer when enabled", () => {
    const harness = createRuntime();
    harness.target.dispatch("pointermove", pointerEvent(200, 240));
    harness.runtime.setEnabled(false);

    expect(harness.cancelFrame).toHaveBeenCalledOnce();
    expect(harness.onPointer).toHaveBeenLastCalledWith(null);
    const requestCountWhileDisabled = harness.requestFrame.mock.calls.length;
    harness.target.dispatch("pointermove", pointerEvent(260, 300));
    expect(harness.requestFrame.mock.calls.length).toBe(requestCountWhileDisabled);

    harness.runtime.setEnabled(true);
    expect(harness.requestFrame).toHaveBeenCalledTimes(requestCountWhileDisabled + 1);
    harness.flush();
    expect(harness.onPointer).toHaveBeenLastCalledWith({
      clientX: 260,
      clientY: 300,
      frameBounds: harness.frameBounds,
      enabled: true,
      pointerType: "mouse",
    });

    harness.target.dispatch("pointermove", pointerEvent(300, 340, "touch"));
    expect(harness.onPointer).toHaveBeenLastCalledWith(null);
    harness.runtime.destroy();
  });

  it("neutralizes leave, blur, hidden state, invalid bounds, and destroy", () => {
    const harness = createRuntime();
    harness.target.dispatch("pointermove", pointerEvent(160, 180));
    harness.flush();

    harness.target.dispatch("pointerleave", new Event("pointerleave"));
    expect(harness.onPointer).toHaveBeenLastCalledWith(null);

    harness.target.dispatch("pointermove", pointerEvent(170, 190));
    harness.flush();
    harness.windowTarget.dispatch("blur", new Event("blur"));
    expect(harness.onPointer).toHaveBeenLastCalledWith(null);

    harness.target.dispatch("pointermove", pointerEvent(180, 200));
    harness.flush();
    harness.visibilityTarget.visibilityState = "hidden";
    harness.visibilityTarget.dispatch("visibilitychange", new Event("visibilitychange"));
    expect(harness.onPointer).toHaveBeenLastCalledWith(null);

    harness.visibilityTarget.visibilityState = "visible";
    const throwing = createRuntime({
      getFrameBounds: () => {
        throw new Error("bounds unavailable");
      },
    });
    throwing.target.dispatch("pointermove", pointerEvent(180, 200));
    throwing.flush();
    expect(throwing.onPointer).toHaveBeenLastCalledWith(null);

    harness.target.dispatch("pointermove", pointerEvent(190, 210));
    harness.runtime.destroy();
    expect(harness.cancelFrame).toHaveBeenCalledOnce();
    expect(harness.onPointer).toHaveBeenLastCalledWith(null);
    const removeCount = harness.target.removeEventListener.mock.calls.length
      + harness.windowTarget.removeEventListener.mock.calls.length
      + harness.visibilityTarget.removeEventListener.mock.calls.length;
    harness.runtime.destroy();
    expect(harness.onPointer).toHaveBeenCalledTimes(7);
    expect(harness.target.removeEventListener.mock.calls.length
      + harness.windowTarget.removeEventListener.mock.calls.length
      + harness.visibilityTarget.removeEventListener.mock.calls.length).toBe(removeCount);
    throwing.runtime.destroy();
  });

  it("stays neutral when created or moved while the visibility target is already hidden", () => {
    const harness = createRuntime();
    harness.visibilityTarget.visibilityState = "hidden";

    harness.target.dispatch("pointermove", pointerEvent(220, 240));
    expect(harness.requestFrame).not.toHaveBeenCalled();
    expect(harness.onPointer).toHaveBeenLastCalledWith(null);

    harness.runtime.sync();
    expect(harness.onPointer).toHaveBeenLastCalledWith(null);
    harness.runtime.destroy();
  });
});
