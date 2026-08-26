import { describe, expect, it } from "vitest";
import sourceManifest from "../../public/assets/learning-room/v1/manifest.json";
import {
  mediaAssetUrl,
  parseLearningRoomManifest,
} from "./learning-room-manifest";

const rejectedRuntimeMedia = [
  "graph-entry-fog-v1.mp4",
  "validation-ink-bloom-v1.mp4",
  "companion-wake-v1.webm",
  "companion-confirm-v1.webm",
  "review-card-tray-v1.png",
  "review-card-stand-v2.png",
] as const;

describe("learning-room manifest boundary", () => {
  it("parses the richer source format and emits the flat M1 projection", () => {
    const manifest = parseLearningRoomManifest(sourceManifest);

    expect(manifest.basePath).toBe("/assets/learning-room/v1");
    expect(manifest.normalized.version).toBe(1);
    expect(manifest.normalized.assets["posters.day"]).toBe("posters/room-day.webp");
    expect(manifest.reviewPosters.day.id).toBe("STATIC-REVIEW-SEAT-DAY-01");
    expect(manifest.reviewPosters.night.id).toBe("STATIC-REVIEW-SEAT-NIGHT-01");
    expect(manifest.normalized.assets["reviewPosters.day"]).toBe("posters/review-seat-day-v1.png");
    expect(manifest.normalized.assets["reviewPosters.night"]).toBe("posters/review-seat-night-v1.png");
    expect(manifest.normalized.assets["window.mask"]).toBe("masks/window-glass-mask-v1.svg");
    expect(manifest.graph.motionImplementation).toBe("code");
    expect(manifest.validation.motionImplementation).toBe("code");
    expect(manifest.normalized.assets).not.toHaveProperty("graph.motion");
    expect(manifest.normalized.assets).not.toHaveProperty("validation.motion");
    for (const rejectedName of rejectedRuntimeMedia) {
      expect(Object.values(manifest.normalized.assets).some((assetPath) => assetPath.endsWith(rejectedName))).toBe(false);
    }
  });

  it("rejects unknown source keys and traversal paths", () => {
    const withUnknown = JSON.parse(JSON.stringify(sourceManifest)) as Record<string, unknown>;
    withUnknown.unregistered = true;
    expect(() => parseLearningRoomManifest(withUnknown)).toThrow();

    const withUnknownReviewPoster = JSON.parse(JSON.stringify(sourceManifest)) as {
      reviewPosters: Record<string, unknown>;
    };
    withUnknownReviewPoster.reviewPosters.extra = true;
    expect(() => parseLearningRoomManifest(withUnknownReviewPoster)).toThrow();

    const withTraversal = JSON.parse(JSON.stringify(sourceManifest)) as {
      window: { mask: string };
    };
    withTraversal.window.mask = "../outside.svg";
    expect(() => parseLearningRoomManifest(withTraversal)).toThrow();
  });

  it("only builds fixed same-origin asset URLs", () => {
    const manifest = parseLearningRoomManifest(sourceManifest);
    expect(mediaAssetUrl(manifest, manifest.posters.day.path)).toBe(
      "/assets/learning-room/v1/posters/room-day.webp",
    );
    expect(mediaAssetUrl(manifest, manifest.reviewPosters.day.path)).toBe(
      "/assets/learning-room/v1/posters/review-seat-day-v1.png",
    );
    expect(() => mediaAssetUrl(manifest, "https://example.com/asset.webp")).toThrow();
    expect(() => mediaAssetUrl(manifest, "unregistered.webp")).toThrow();
  });
});
