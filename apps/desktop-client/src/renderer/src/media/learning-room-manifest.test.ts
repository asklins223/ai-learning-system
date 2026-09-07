import { describe, expect, it } from "vitest";
import sourceManifest from "../../public/assets/learning-room/v1/manifest.json";
import {
  mediaAssetUrl,
  parseLearningRoomManifest,
  resolveDoorEntryAssetUrls,
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
    expect(manifest.entryPosters.closed.day.id).toBe("STATIC-LOGIN-ENTRY-CLOSED-DAY-01");
    expect(manifest.entryPosters.open.night.id).toBe("STATIC-LOGIN-ENTRY-OPEN-NIGHT-01");
    expect(manifest.authPosters.day.id).toBe("STATIC-AUTH-ALCOVE-DAY-01");
    expect(manifest.authPosters.dusk.id).toBe("STATIC-AUTH-ALCOVE-DUSK-01");
    expect(manifest.registerPosters.night.id).toBe("STATIC-AUTH-REGISTER-NIGHT-01");
    expect(manifest.registerPosters.dusk.id).toBe("STATIC-AUTH-REGISTER-DUSK-01");
    expect(manifest.normalized.assets["entryPosters.closed.day"]).toBe("posters/login-entry/entry-door-closed-day-v1.png");
    expect(manifest.normalized.assets["entryPosters.open.night"]).toBe("posters/login-entry/entry-door-open-night-v1.png");
    expect(manifest.normalized.assets["authPosters.day"]).toBe("posters/auth-alcove/auth-alcove-day-v1.png");
    expect(manifest.normalized.assets["authPosters.dusk"]).toBe("posters/auth-alcove/auth-alcove-dusk-v1.png");
    expect(manifest.normalized.assets["authPosters.night"]).toBe("posters/auth-alcove/auth-alcove-night-v1.png");
    expect(manifest.normalized.assets["registerPosters.day"]).toBe("posters/auth-register/register-worktable-day-v1.png");
    expect(manifest.normalized.assets["registerPosters.dusk"]).toBe("posters/auth-register/register-worktable-dusk-v1.png");
    expect(manifest.normalized.assets["registerPosters.night"]).toBe("posters/auth-register/register-worktable-night-v1.png");
    expect(manifest.normalized.assets["objects.loginDoorSlabDay"]).toBe("objects/login-entry/door-slab-day-v2.png");
    expect(manifest.normalized.assets["objects.loginDoorSlabNight"]).toBe("objects/login-entry/door-slab-night-v2.png");
    expect(manifest.searchPosters.day.id).toBe("STATIC-SEARCH-REFERENCE-DAY-01");
    expect(manifest.searchPosters.night.id).toBe("STATIC-SEARCH-REFERENCE-NIGHT-01");
    expect(manifest.normalized.assets["searchPosters.day"]).toBe("posters/search-reference-day-v1.png");
    expect(manifest.normalized.assets["searchPosters.night"]).toBe("posters/search-reference-night-v1.png");
    expect(manifest.searchForeground.day.id).toBe("STATIC-SEARCH-FOREGROUND-DAY-01");
    expect(manifest.searchForeground.night.id).toBe("STATIC-SEARCH-FOREGROUND-NIGHT-01");
    expect(manifest.normalized.assets["searchForeground.day"]).toBe("foreground/search-foreground-day-v1.png");
    expect(manifest.normalized.assets["searchForeground.night"]).toBe("foreground/search-foreground-night-v1.png");
    expect(manifest.normalized.assets["reviewPosters.day"]).toBe("posters/review-seat-day-v1.png");
    expect(manifest.normalized.assets["reviewPosters.night"]).toBe("posters/review-seat-night-v1.png");
    expect(manifest.roomLayers).toEqual([]);
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

    const withUnknownSearchPoster = JSON.parse(JSON.stringify(sourceManifest)) as {
      searchPosters: Record<string, unknown>;
    };
    withUnknownSearchPoster.searchPosters.extra = true;
    expect(() => parseLearningRoomManifest(withUnknownSearchPoster)).toThrow();

    const withTraversal = JSON.parse(JSON.stringify(sourceManifest)) as {
      window: { mask: string };
    };
    withTraversal.window.mask = "../outside.svg";
    expect(() => parseLearningRoomManifest(withTraversal)).toThrow();
  });

  it("rejects duplicate independent Room layer ids", () => {
    const withDuplicateLayers = JSON.parse(JSON.stringify(sourceManifest)) as {
      roomLayers: unknown[];
    };
    const layer = {
      assetId: "STATIC-ROOM-FOREGROUND-01",
      path: "foreground/room-foreground-day-v1.png",
      theme: "day",
      depth: "D6",
      order: 0,
      anchorId: null,
      sourceSize: { width: 1672, height: 941 },
      registration: {
        position: [0, 0],
        size: { width: 1672, height: 941 },
        anchor: [0, 0],
      },
      alphaMode: "straight-rgba",
      reviewStatus: "approved",
      releaseApproval: true,
    };
    withDuplicateLayers.roomLayers = [layer, { ...layer, path: "foreground/room-foreground-night-v1.png", order: 1 }];
    expect(() => parseLearningRoomManifest(withDuplicateLayers)).toThrow();
  });

  it("rejects duplicate same-band orders and out-of-range orders", () => {
    const withDuplicateOrders = JSON.parse(JSON.stringify(sourceManifest)) as {
      roomLayers: unknown[];
    };
    const layer = {
      assetId: "STATIC-ROOM-ORDER-01",
      path: "foreground/room-foreground-day-v1.png",
      theme: "day",
      depth: "D6",
      order: 4,
      anchorId: null,
      sourceSize: { width: 1672, height: 941 },
      registration: {
        position: [0, 0],
        size: { width: 1672, height: 941 },
        anchor: [0, 0],
      },
      alphaMode: "straight-rgba",
      reviewStatus: "approved",
      releaseApproval: true,
    };
    withDuplicateOrders.roomLayers = [layer, { ...layer, assetId: "STATIC-ROOM-ORDER-02" }];
    expect(() => parseLearningRoomManifest(withDuplicateOrders)).toThrow();

    withDuplicateOrders.roomLayers = [{ ...layer, order: 64 }];
    expect(() => parseLearningRoomManifest(withDuplicateOrders)).toThrow();
  });

  it("rejects Room layer anchors outside the registered room scene", () => {
    const withUnknownAnchor = JSON.parse(JSON.stringify(sourceManifest)) as {
      roomLayers: unknown[];
    };
    withUnknownAnchor.roomLayers = [{
      assetId: "STATIC-ROOM-ANCHOR-01",
      path: "foreground/room-foreground-day-v1.png",
      theme: "day",
      depth: "D4",
      order: 0,
      anchorId: "room.unknown",
      sourceSize: { width: 1672, height: 941 },
      registration: {
        position: [0, 0],
        size: { width: 1672, height: 941 },
        anchor: [0, 0],
      },
      alphaMode: "straight-rgba",
      reviewStatus: "IN_REVIEW",
      releaseApproval: false,
    }];

    expect(() => parseLearningRoomManifest(withUnknownAnchor)).toThrow();
  });

  it("rejects Room layer registrations outside the canonical world", () => {
    const withOutOfBoundsRegistration = JSON.parse(JSON.stringify(sourceManifest)) as {
      roomLayers: unknown[];
    };
    withOutOfBoundsRegistration.roomLayers = [{
      assetId: "STATIC-ROOM-OUT-OF-BOUNDS-01",
      path: "foreground/room-foreground-day-v1.png",
      theme: "day",
      depth: "D6",
      order: 0,
      anchorId: null,
      sourceSize: { width: 1672, height: 941 },
      registration: {
        position: [-3, 0],
        size: { width: 64, height: 32 },
        anchor: [0, 0],
      },
      alphaMode: "straight-rgba",
      reviewStatus: "IN_REVIEW",
      releaseApproval: false,
    }];

    expect(() => parseLearningRoomManifest(withOutOfBoundsRegistration)).toThrow();
  });

  it("registers Room layer paths without making them eligible by metadata alone", () => {
    const withLayer = JSON.parse(JSON.stringify(sourceManifest)) as {
      roomLayers: unknown[];
    };
    withLayer.roomLayers = [{
      assetId: "STATIC-ROOM-FOREGROUND-01",
      path: "foreground/room-foreground-day-v1.png",
      theme: "day",
      depth: "D6",
      order: 0,
      anchorId: null,
      sourceSize: { width: 1672, height: 941 },
      registration: {
        position: [0, 0],
        size: { width: 1672, height: 941 },
        anchor: [0, 0],
      },
      alphaMode: "straight-rgba",
      reviewStatus: "IN_REVIEW",
      releaseApproval: false,
    }];

    const manifest = parseLearningRoomManifest(withLayer);
    expect(manifest.roomLayers).toHaveLength(1);
    expect(manifest.normalized.assets["roomLayers.0"]).toBe(
      "foreground/room-foreground-day-v1.png",
    );
    expect(mediaAssetUrl(manifest, manifest.roomLayers[0].path)).toBe(
      "/assets/learning-room/v1/foreground/room-foreground-day-v1.png",
    );
  });

  it("only builds fixed same-origin asset URLs", () => {
    const manifest = parseLearningRoomManifest(sourceManifest);
    expect(mediaAssetUrl(manifest, manifest.posters.day.path)).toBe(
      "/assets/learning-room/v1/posters/room-day.webp",
    );
    expect(mediaAssetUrl(manifest, manifest.reviewPosters.day.path)).toBe(
      "/assets/learning-room/v1/posters/review-seat-day-v1.png",
    );
    expect(mediaAssetUrl(manifest, manifest.entryPosters.open.day.path)).toBe(
      "/assets/learning-room/v1/posters/login-entry/entry-door-open-day-v1.png",
    );
    expect(mediaAssetUrl(manifest, manifest.searchPosters.day.path)).toBe(
      "/assets/learning-room/v1/posters/search-reference-day-v1.png",
    );
    expect(mediaAssetUrl(manifest, manifest.searchForeground.day.path)).toBe(
      "/assets/learning-room/v1/foreground/search-foreground-day-v1.png",
    );
    expect(() => mediaAssetUrl(manifest, "https://example.com/asset.webp")).toThrow();
    expect(() => mediaAssetUrl(manifest, "unregistered.webp")).toThrow();
  });

  it("resolves the door transition from canonical manifest records", () => {
    const manifest = parseLearningRoomManifest(sourceManifest);

    expect(resolveDoorEntryAssetUrls(manifest, "day")).toEqual({
      closed: "/assets/learning-room/v1/posters/login-entry/entry-door-closed-day-v1.png",
      home: "/assets/learning-room/v1/posters/room-day.webp",
    });
    expect(resolveDoorEntryAssetUrls(manifest, "night")).toEqual({
      closed: "/assets/learning-room/v1/posters/login-entry/entry-door-closed-night-v1.png",
      home: "/assets/learning-room/v1/posters/room-night.webp",
    });
  });
});
