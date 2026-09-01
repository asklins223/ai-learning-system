import { describe, expect, it } from "vitest";
import { projectSceneCameraPoint, SCENE_CAMERA_PRESETS, sceneCameraMatrixForViewport } from "./scene-camera";
import { projectSurfacePoint } from "./scene-input";
import {
  resolveSceneSurfacePointerEvent,
  writeSceneInputDiagnostics,
  type ScenePointerEventLike,
  type SceneSurfaceInputTarget,
} from "./scene-input-runtime";
import { STUDY_SURFACE_REGISTRY, type SceneSurfaceRegistration } from "./scene-surfaces";

function targetFor(surface: SceneSurfaceRegistration, element: EventTarget): SceneSurfaceInputTarget {
  return {
    ref: { current: element } as SceneSurfaceInputTarget["ref"],
    surface,
  };
}

function pointerAtSurface(surface: SceneSurfaceRegistration, element: EventTarget | null): ScenePointerEventLike {
  const point = projectSurfacePoint(surface, [0.5, 0.5]);
  if (!point) throw new Error("test Surface did not project");
  return {
    type: "pointermove",
    clientX: 10 + point[0],
    clientY: 20 + point[1],
    pointerId: 7,
    pointerType: "mouse",
    buttons: 0,
    target: element,
    composedPath: () => element ? [element] : [],
  };
}

describe("scene surface pointer runtime", () => {
  const surface = STUDY_SURFACE_REGISTRY.surfaces.notebookLeft;
  const frameBounds = { left: 10, top: 20, width: 1672, height: 941 };

  it("keeps the real DOM Surface as the owner when the geometry also matches", () => {
    const element = {} as EventTarget;
    const result = resolveSceneSurfacePointerEvent({
      event: pointerAtSurface(surface, element),
      frameBounds,
      targets: [targetFor(surface, element)],
    });

    expect(result.surfaceId).toBe(surface.id);
    expect(result.domSurfaceId).toBe(surface.id);
    expect(result.domOwned).toBe(true);
    expect(result.resolution?.inside).toBe(true);
  });

  it("allows a future renderer to inspect a unique geometry candidate without claiming DOM ownership", () => {
    const background = {} as EventTarget;
    const event = { ...pointerAtSurface(surface, background), composedPath: () => [background] };
    const result = resolveSceneSurfacePointerEvent({
      event,
      frameBounds,
      targets: [targetFor(surface, {} as EventTarget)],
    });

    expect(result.surfaceId).toBe(surface.id);
    expect(result.domSurfaceId).toBeNull();
    expect(result.domOwned).toBe(false);
  });

  it("passes the explicit camera matrix through the same unique-candidate path", () => {
    const viewport = { width: 1672, height: 941 };
    const cameraMatrix = sceneCameraMatrixForViewport(SCENE_CAMERA_PRESETS.study, viewport);
    const worldPoint = projectSurfacePoint(surface, [0.5, 0.5]);
    const cameraPoint = projectSceneCameraPoint(worldPoint!, cameraMatrix!);
    const event: ScenePointerEventLike = {
      type: "pointermove",
      clientX: 30 + (cameraPoint![0] / viewport.width) * 1200,
      clientY: 40 + (cameraPoint![1] / viewport.height) * 675,
      pointerType: "mouse",
      target: null,
      composedPath: () => [],
    };
    const result = resolveSceneSurfacePointerEvent({
      event,
      frameBounds: { left: 30, top: 40, width: 1200, height: 675 },
      targets: [targetFor(surface, {} as EventTarget)],
      cameraMatrix: cameraMatrix!,
    });

    expect(result.surfaceId).toBe(surface.id);
    expect(result.domOwned).toBe(false);
    expect(result.resolution?.inside).toBe(true);
  });

  it("does not select an arbitrary Surface when geometry candidates are ambiguous", () => {
    const secondSurface = { ...surface, id: "study.notebook.left-page-copy" };
    const result = resolveSceneSurfacePointerEvent({
      event: pointerAtSurface(surface, {} as EventTarget),
      frameBounds,
      targets: [
        targetFor(surface, {} as EventTarget),
        targetFor(secondSurface, {} as EventTarget),
      ],
    });

    expect(result.candidates.map((candidate) => candidate.surfaceId)).toEqual([
      surface.id,
      secondSurface.id,
    ]);
    expect(result.surfaceId).toBeNull();
    expect(result.resolution).toBeNull();
  });

  it("writes only development diagnostics and clears them on pointer exit", () => {
    const frame = { dataset: {} } as unknown as HTMLElement;
    const element = {} as EventTarget;
    const input = resolveSceneSurfacePointerEvent({
      event: pointerAtSurface(surface, element),
      frameBounds,
      targets: [targetFor(surface, element)],
    });

    writeSceneInputDiagnostics(frame, input);

    expect(frame.dataset).toMatchObject({
      sceneInputCandidates: "1",
      sceneInputSurface: surface.id,
      sceneInputDomSurface: surface.id,
      sceneInputOwnership: "dom",
      sceneInputState: "inside",
    });

    writeSceneInputDiagnostics(frame, { ...input, eventType: "pointerleave" });

    expect(frame.dataset.sceneInputCandidates).toBeUndefined();
    expect(frame.dataset.sceneInputSurface).toBeUndefined();
    expect(frame.dataset.sceneInputDomSurface).toBeUndefined();
    expect(frame.dataset.sceneInputOwnership).toBeUndefined();
    expect(frame.dataset.sceneInputState).toBeUndefined();
  });

  it("keeps outside and non-finite pointers fail-closed", () => {
    const outside: ScenePointerEventLike = {
      type: "pointermove",
      clientX: -100,
      clientY: -100,
      target: null,
      composedPath: () => [],
    };
    const result = resolveSceneSurfacePointerEvent({
      event: outside,
      frameBounds,
      targets: [targetFor(surface, {} as EventTarget)],
    });
    const invalid = resolveSceneSurfacePointerEvent({
      event: { ...outside, clientX: Number.NaN },
      frameBounds,
      targets: [targetFor(surface, {} as EventTarget)],
    });

    expect(result.surfaceId).toBeNull();
    expect(result.candidates).toHaveLength(0);
    expect(invalid.worldPoint).toBeNull();
    expect(invalid.surfaceId).toBeNull();
  });
});
