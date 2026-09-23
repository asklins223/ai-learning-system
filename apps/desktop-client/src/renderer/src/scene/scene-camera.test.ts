import { describe, expect, it } from "vitest";
import {
  projectSceneCameraPoint,
  SCENE_CAMERA_PRESETS,
  sceneCameraCssValues,
  sceneCameraMatrixForViewport,
  unprojectSceneCameraPoint,
} from "./scene-camera";
import { SCENE_WORLD } from "./scene-geometry";

describe("scene camera contract", () => {
  it("keeps one finite named preset for every desktop destination", () => {
    expect(Object.keys(SCENE_CAMERA_PRESETS)).toEqual([
      "room",
      "study",
      "notebook",
      "card-generation",
      "review",
      "search",
      "graph",
      "validation",
      "source-library",
      "source-detail",
      "note-library",
      "objective-library",
      "objective-detail",
      "companion-center",
      "settings",
      // 审计 F24 的「未完成的学习」：取景跟着研究册那一档。
      "resumable",
    ]);
    for (const preset of Object.values(SCENE_CAMERA_PRESETS)) {
      expect(preset.scale).toBeGreaterThanOrEqual(1);
      expect(Number.isFinite(preset.xPercent)).toBe(true);
      expect(Number.isFinite(preset.yPercent)).toBe(true);
    }
  });

  it("serializes the same camera values consumed by CSS scene rigs", () => {
    expect(sceneCameraCssValues(SCENE_CAMERA_PRESETS.study)).toEqual({
      "--scene-camera-scale": "1.12",
      "--scene-camera-x-percent": "0%",
      "--scene-camera-y-percent": "-3.5%",
    });
  });

  it("projects and unprojects through one finite matrix for every named camera", () => {
    const viewport = { width: 1200, height: 675 };
    const worldPoint = [731.25, 412.5] as const;

    for (const preset of Object.values(SCENE_CAMERA_PRESETS)) {
      const matrix = sceneCameraMatrixForViewport(preset, viewport);
      expect(matrix).not.toBeNull();
      const screenPoint = projectSceneCameraPoint(worldPoint, matrix!);
      const roundTrip = unprojectSceneCameraPoint(screenPoint!, matrix!);

      expect(roundTrip?.[0]).toBeCloseTo(worldPoint[0], 8);
      expect(roundTrip?.[1]).toBeCloseTo(worldPoint[1], 8);
    }
  });

  it("keeps the room preset aligned to the reference-frame bounds", () => {
    const viewport = { width: 1672, height: 941 };
    const matrix = sceneCameraMatrixForViewport(SCENE_CAMERA_PRESETS.room, viewport);

    expect(projectSceneCameraPoint([0, 0], matrix!)).toEqual([0, 0]);
    expect(projectSceneCameraPoint([SCENE_WORLD.width, SCENE_WORLD.height], matrix!)).toEqual([
      viewport.width,
      viewport.height,
    ]);
  });

  it("keeps named translation in the same centered convention as the CSS camera", () => {
    const viewport = { width: 1200, height: 675 };
    const matrix = sceneCameraMatrixForViewport(SCENE_CAMERA_PRESETS.study, viewport);
    const center = projectSceneCameraPoint([SCENE_WORLD.width / 2, SCENE_WORLD.height / 2], matrix!);

    expect(center?.[0]).toBeCloseTo(viewport.width / 2, 8);
    expect(center?.[1]).toBeCloseTo(viewport.height / 2 - viewport.height * 0.035, 8);
  });

  it("rejects unusable viewport dimensions instead of producing a partial matrix", () => {
    expect(sceneCameraMatrixForViewport(SCENE_CAMERA_PRESETS.study, { width: 0, height: 675 })).toBeNull();
    expect(sceneCameraMatrixForViewport(SCENE_CAMERA_PRESETS.study, { width: 1200, height: Number.NaN })).toBeNull();
  });
});
