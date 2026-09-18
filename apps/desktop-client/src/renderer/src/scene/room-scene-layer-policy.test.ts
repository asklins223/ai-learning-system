import { Container, Texture } from "pixi.js";
import { describe, expect, it } from "vitest";
import {
  createRoomSceneLayerNode,
  resolveRoomSceneLayerEligibility,
  resolveRoomSceneLayerRegistrationEligibility,
  resolveRoomSceneLayerUploadAlphaMode,
  type RoomSceneLayerSource,
} from "./room-scene-layer-policy";

const approvedSource: RoomSceneLayerSource = {
  assetId: "STATIC-ROOM-FOREGROUND-01",
  path: "foreground/room-foreground-day-v1.png",
  sourceSize: { width: 1, height: 1 },
  alphaMode: "straight-rgba",
  reviewStatus: "approved",
  releaseApproval: true,
};

const validRegistration = {
  position: [120, 80] as const,
  size: { width: 64, height: 32 },
  anchor: [0.5, 0.5] as const,
};

describe("Room independent raster layer policy", () => {
  it("maps asset-ledger alpha metadata to Pixi upload semantics", () => {
    expect(resolveRoomSceneLayerUploadAlphaMode("straight-rgba")).toBe("premultiply-alpha-on-upload");
    expect(resolveRoomSceneLayerUploadAlphaMode("blend")).toBe("premultiply-alpha-on-upload");
    expect(resolveRoomSceneLayerUploadAlphaMode("premultiplied-rgba")).toBe("premultiplied-alpha");
    expect(resolveRoomSceneLayerUploadAlphaMode("opaque-rgb")).toBe("no-premultiply-alpha");
  });

  it("accepts only a reviewed, release-approved transparent source", () => {
    expect(resolveRoomSceneLayerEligibility(approvedSource)).toEqual({
      enabled: true,
      reason: "eligible",
    });
  });

  it("rejects opaque layers before they can be mounted", () => {
    expect(resolveRoomSceneLayerEligibility({
      ...approvedSource,
      alphaMode: "opaque-rgb",
    })).toEqual({ enabled: false, reason: "opaque-layer" });
    expect(resolveRoomSceneLayerEligibility({
      ...approvedSource,
      alphaMode: "opaque-rgb",
    }, { allowOpaque: true })).toEqual({ enabled: true, reason: "eligible" });
  });

  it("rejects review-only and unapproved sources independently", () => {
    expect(resolveRoomSceneLayerEligibility({
      ...approvedSource,
      reviewStatus: "CANDIDATE_AWAITING_OWNER_REVIEW",
    })).toEqual({ enabled: false, reason: "review-not-approved" });
    expect(resolveRoomSceneLayerEligibility({
      ...approvedSource,
      releaseApproval: false,
    })).toEqual({ enabled: false, reason: "release-not-approved" });
  });

  it("fails closed for malformed source metadata", () => {
    expect(resolveRoomSceneLayerEligibility(null)).toEqual({ enabled: false, reason: "invalid-source" });
    expect(resolveRoomSceneLayerEligibility({
      ...approvedSource,
      assetId: " ",
    })).toEqual({ enabled: false, reason: "invalid-source" });
    expect(resolveRoomSceneLayerEligibility({
      ...approvedSource,
      sourceSize: { width: 0, height: 1 },
    })).toEqual({ enabled: false, reason: "invalid-source" });
  });

  it("accepts world registrations with the explicit two-pixel edge bleed", () => {
    expect(resolveRoomSceneLayerRegistrationEligibility({
      position: [0, 0],
      size: { width: 1674, height: 943 },
      anchor: [0, 0],
    })).toEqual({ enabled: true, reason: "eligible" });
    expect(resolveRoomSceneLayerRegistrationEligibility({
      position: [-3, 0],
      size: { width: 64, height: 32 },
      anchor: [0, 0],
    })).toEqual({ enabled: false, reason: "registration-out-of-bounds" });
    expect(resolveRoomSceneLayerRegistrationEligibility({
      position: [0, 0],
      size: { width: 64, height: 32 },
      anchor: [2, 0],
    } as never)).toEqual({ enabled: false, reason: "invalid-registration" });
  });

  it("creates a non-interactive node only after the gate passes", () => {
    const texture = Texture.WHITE;
    const result = createRoomSceneLayerNode({
      source: approvedSource,
      depth: "D6",
      texture,
      registration: validRegistration,
      node: { visible: false },
    });

    expect(result.eligibility).toEqual({ enabled: true, reason: "eligible" });
    expect(result.node).toBeInstanceOf(Container);
    expect(result.node?.label).toBe("room-scene-layer:STATIC-ROOM-FOREGROUND-01");
    expect(result.node?.position.x).toBe(validRegistration.position[0]);
    expect(result.node?.position.y).toBe(validRegistration.position[1]);
    expect(result.node?.width).toBe(64);
    expect(result.node?.height).toBe(32);
    expect(result.node?.eventMode).toBe("none");
    expect(result.node?.interactiveChildren).toBe(false);
    expect(result.node?.visible).toBe(false);

    result.node?.destroy();
    expect(texture.destroyed).toBe(false);
  });

  it("does not create a node for an unavailable texture", () => {
    const texture = new Texture();
    texture.destroy();

    const result = createRoomSceneLayerNode({
      source: approvedSource,
      depth: "D3",
      texture,
      registration: validRegistration,
    });

    expect(result).toEqual({
      eligibility: { enabled: false, reason: "invalid-source" },
      node: null,
    });
  });

  it("rejects a decoded texture whose pixels do not match the manifest sourceSize", () => {
    const result = createRoomSceneLayerNode({
      source: { ...approvedSource, sourceSize: { width: 2, height: 1 } },
      depth: "D3",
      texture: Texture.WHITE,
      registration: validRegistration,
    });

    expect(result).toEqual({
      eligibility: { enabled: false, reason: "source-size-mismatch" },
      node: null,
    });
  });

  it("does not create a node outside the canonical world registration", () => {
    const result = createRoomSceneLayerNode({
      source: approvedSource,
      depth: "D3",
      texture: Texture.WHITE,
      registration: {
        position: [-3, 80],
        size: { width: 64, height: 32 },
        anchor: [0, 0],
      },
    });

    expect(result).toEqual({
      eligibility: { enabled: false, reason: "registration-out-of-bounds" },
      node: null,
    });
  });
});
