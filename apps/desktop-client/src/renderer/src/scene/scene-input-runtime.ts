import { useEffect, useRef, type RefObject } from "react";
import {
  clientPointToReferenceWorld,
  resolveSurfaceInput,
  type SceneFrameBounds,
  type SurfaceInputResolution,
} from "./scene-input";
import type { SceneCameraMatrix } from "./scene-camera";
import type { ScenePoint, SceneQuad } from "./scene-geometry";
import type { SceneSurfaceRegistration } from "./scene-surfaces";

export type SceneSurfaceInputTarget = Readonly<{
  readonly ref: RefObject<HTMLElement | null>;
  readonly surface: SceneSurfaceRegistration;
}>;

export type ScenePointerEventLike = Readonly<{
  readonly type: string;
  readonly clientX: number;
  readonly clientY: number;
  readonly pointerId?: number;
  readonly pointerType?: string;
  readonly buttons?: number;
  readonly target?: EventTarget | null;
  readonly composedPath?: () => readonly EventTarget[];
}>;

export type SceneSurfacePointerCandidate = Readonly<{
  readonly surfaceId: string;
  readonly resolution: SurfaceInputResolution;
}>;

export type SceneSurfacePointerResolution = Readonly<{
  readonly eventType: string;
  readonly pointerId: number;
  readonly pointerType: string;
  readonly buttons: number;
  readonly clientPoint: ScenePoint;
  readonly worldPoint: ScenePoint | null;
  /** The Surface element present in the event's composed path, if any. */
  readonly domSurfaceId: string | null;
  /** All registered Surfaces whose geometry contains this point. */
  readonly candidates: readonly SceneSurfacePointerCandidate[];
  /** A unique geometry candidate, or the DOM-path candidate when available. */
  readonly surfaceId: string | null;
  readonly resolution: SurfaceInputResolution | null;
  /** True only when the selected candidate is also the actual DOM target Surface. */
  readonly domOwned: boolean;
}>;

export type SceneSurfaceInputRuntimeOptions = Readonly<{
  readonly active: boolean;
  readonly compactMediaQuery: string;
  readonly referenceFrameRef: RefObject<HTMLElement | null>;
  readonly targets: readonly SceneSurfaceInputTarget[];
  readonly quadOverrides?: Readonly<Record<string, SceneQuad>>;
  /** Optional only for a renderer viewport whose frame bounds are untransformed. */
  readonly cameraMatrix?: SceneCameraMatrix;
  readonly onInput?: (input: SceneSurfacePointerResolution) => void;
}>;

function eventPath(event: ScenePointerEventLike): readonly EventTarget[] {
  try {
    const path = event.composedPath?.();
    if (path?.length) return path;
  } catch {
    // A hostile or detached event should simply fall back to its direct target.
  }
  return event.target ? [event.target] : [];
}

function domSurfaceIdForEvent(
  event: ScenePointerEventLike,
  targets: readonly SceneSurfaceInputTarget[],
): string | null {
  const path = eventPath(event);
  for (const pathTarget of path) {
    const target = targets.find((candidate) => candidate.ref.current === pathTarget);
    if (target) return target.surface.id;
  }

  if (!event.target) return null;
  for (const target of targets) {
    const element = target.ref.current;
    if (!element) continue;
    if (event.target === element) return target.surface.id;
    try {
      if (element.contains(event.target as Node)) return target.surface.id;
    } catch {
      // Synthetic or detached targets are not DOM-owned.
    }
  }
  return null;
}

function frameBoundsOf(frame: HTMLElement): SceneFrameBounds {
  const bounds = frame.getBoundingClientRect();
  return {
    left: bounds.left,
    top: bounds.top,
    width: bounds.width,
    height: bounds.height,
  };
}

function clearSceneInputDiagnostics(frame: HTMLElement): void {
  delete frame.dataset.sceneInputCandidates;
  delete frame.dataset.sceneInputSurface;
  delete frame.dataset.sceneInputDomSurface;
  delete frame.dataset.sceneInputOwnership;
  delete frame.dataset.sceneInputState;
}

function setSceneInputDiagnostic(frame: HTMLElement, key: keyof DOMStringMap, value: string): void {
  if (frame.dataset[key] !== value) frame.dataset[key] = value;
}

/** Write the non-visual development contract without changing event ownership. */
export function writeSceneInputDiagnostics(
  frame: HTMLElement,
  input: SceneSurfacePointerResolution,
): void {
  if (input.eventType === "pointerleave" || input.eventType === "pointercancel") {
    clearSceneInputDiagnostics(frame);
    return;
  }
  setSceneInputDiagnostic(frame, "sceneInputCandidates", String(input.candidates.length));
  setSceneInputDiagnostic(frame, "sceneInputSurface", input.surfaceId ?? "");
  setSceneInputDiagnostic(frame, "sceneInputDomSurface", input.domSurfaceId ?? "");
  setSceneInputDiagnostic(frame, "sceneInputOwnership", input.domOwned ? "dom" : input.surfaceId ? "geometry" : "none");
  setSceneInputDiagnostic(
    frame,
    "sceneInputState",
    input.surfaceId ? "inside" : input.candidates.length > 1 ? "ambiguous" : "outside",
  );
}

/**
 * Resolve a pointer without stopping propagation or assigning business meaning
 * to the result. DOM ownership is reported separately from geometry fallback so
 * a future Canvas can consume the same contract without stealing DOM hits.
 */
export function resolveSceneSurfacePointerEvent(input: {
  readonly event: ScenePointerEventLike;
  readonly frameBounds: SceneFrameBounds;
  readonly targets: readonly SceneSurfaceInputTarget[];
  readonly quadOverrides?: Readonly<Record<string, SceneQuad>>;
  readonly cameraMatrix?: SceneCameraMatrix;
}): SceneSurfacePointerResolution {
  const { event, frameBounds, targets, quadOverrides, cameraMatrix } = input;
  const clientPoint: ScenePoint = [event.clientX, event.clientY];
  const worldPoint = clientPointToReferenceWorld(clientPoint, frameBounds, cameraMatrix);
  const domSurfaceId = domSurfaceIdForEvent(event, targets);
  const candidates = targets.flatMap((target) => {
    const resolution = resolveSurfaceInput({
      clientPoint,
      frameBounds,
      surface: target.surface,
      worldQuad: quadOverrides?.[target.surface.id],
      cameraMatrix,
    });
    return resolution?.inside
      ? [{ surfaceId: target.surface.id, resolution }]
      : [];
  });
  const domCandidate = domSurfaceId ? candidates.find((candidate) => candidate.surfaceId === domSurfaceId) : undefined;
  const selected = domCandidate ?? (domSurfaceId === null && candidates.length === 1 ? candidates[0] : undefined);

  return Object.freeze({
    eventType: event.type,
    pointerId: event.pointerId ?? -1,
    pointerType: event.pointerType ?? "unknown",
    buttons: event.buttons ?? 0,
    clientPoint,
    worldPoint,
    domSurfaceId,
    candidates: Object.freeze(candidates),
    surfaceId: selected?.surfaceId ?? null,
    resolution: selected?.resolution ?? null,
    domOwned: Boolean(selected && domSurfaceId === selected.surfaceId),
  });
}

export function useSceneSurfaceInputRuntime(options: SceneSurfaceInputRuntimeOptions): void {
  const targetsRef = useRef(options.targets);
  const quadOverridesRef = useRef(options.quadOverrides);
  const cameraMatrixRef = useRef(options.cameraMatrix);
  const onInputRef = useRef(options.onInput);
  targetsRef.current = options.targets;
  quadOverridesRef.current = options.quadOverrides;
  cameraMatrixRef.current = options.cameraMatrix;
  onInputRef.current = options.onInput;

  useEffect(() => {
    if (!options.active) return undefined;
    const frame = options.referenceFrameRef.current;
    if (!frame) return undefined;

    const compactQuery = window.matchMedia(options.compactMediaQuery);
    const eventTypes = ["pointermove", "pointerdown", "pointerup", "pointercancel", "pointerleave"] as const;
    const handlePointerEvent = (event: Event) => {
      if (compactQuery.matches) {
        clearSceneInputDiagnostics(frame);
        return;
      }
      const pointerEvent = event as unknown as ScenePointerEventLike;
      const resolution = resolveSceneSurfacePointerEvent({
        event: pointerEvent,
        frameBounds: frameBoundsOf(frame),
        targets: targetsRef.current,
        quadOverrides: quadOverridesRef.current,
        cameraMatrix: cameraMatrixRef.current,
      });
      onInputRef.current?.(resolution);
    };
    const handleCompactChange = () => {
      if (compactQuery.matches) clearSceneInputDiagnostics(frame);
    };

    for (const eventType of eventTypes) {
      frame.addEventListener(eventType, handlePointerEvent, { capture: true, passive: true });
    }
    compactQuery.addEventListener("change", handleCompactChange);
    return () => {
      for (const eventType of eventTypes) {
        frame.removeEventListener(eventType, handlePointerEvent, { capture: true });
      }
      compactQuery.removeEventListener("change", handleCompactChange);
      clearSceneInputDiagnostics(frame);
    };
  }, [options.active, options.compactMediaQuery, options.referenceFrameRef, options.targets]);
}
