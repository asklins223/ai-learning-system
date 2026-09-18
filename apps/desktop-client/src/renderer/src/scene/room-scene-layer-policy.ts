import { Container, type Texture } from "pixi.js";
import type { SceneDepthBandId } from "./scene-depth";
import {
  isRoomSceneLayerRegistrationWithinWorld,
  resolveRoomSceneLayerRegistrationRect,
  type ScenePoint,
  type SceneSize,
} from "./scene-geometry";
import {
  createScenePixiTextureNode,
  type ScenePixiTextureNodeOptions,
} from "./scene-node-pixi";

/**
 * Independent raster layers are a stricter contract than the canonical room
 * poster. They may only enter the Room scene after both visual review and
 * release approval are explicit in the asset ledger.
 */
export type RoomSceneLayerAlphaMode =
  | "straight-rgba"
  | "premultiplied-rgba"
  | "blend"
  | "opaque-rgb";

export type RoomSceneLayerUploadAlphaMode =
  | "premultiply-alpha-on-upload"
  | "premultiplied-alpha"
  | "no-premultiply-alpha";

export type RoomSceneLayerSource = Readonly<{
  readonly assetId: string;
  readonly path: string;
  /** Decoded source pixel dimensions, before the registration size is applied. */
  readonly sourceSize: Readonly<{ width: number; height: number }>;
  readonly alphaMode: RoomSceneLayerAlphaMode;
  readonly reviewStatus: string;
  readonly releaseApproval: boolean;
}>;

export type RoomSceneLayerRegistration = Readonly<{
  readonly position: ScenePoint;
  readonly size: SceneSize;
  readonly anchor: ScenePoint;
}>;

export type RoomSceneLayerBlockReason =
  | "invalid-source"
  | "opaque-layer"
  | "review-not-approved"
  | "release-not-approved"
  | "source-size-mismatch"
  | "invalid-registration"
  | "registration-out-of-bounds";

export type RoomSceneLayerEligibility = Readonly<{
  readonly enabled: boolean;
  readonly reason: "eligible" | RoomSceneLayerBlockReason;
}>;

export type RoomSceneLayerNodeOptions = Readonly<{
  readonly source: RoomSceneLayerSource;
  readonly depth: SceneDepthBandId;
  readonly texture: Texture;
  readonly registration: RoomSceneLayerRegistration;
  readonly node?: Omit<
    ScenePixiTextureNodeOptions,
    "texture" | "position" | "size" | "anchor"
  >;
}>;

export type RoomSceneLayerNodeResult = Readonly<{
  readonly eligibility: RoomSceneLayerEligibility;
  /** Null means the layer must remain out of the production scene graph. */
  readonly node: Container | null;
}>;

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function hasTransparentAlpha(alphaMode: RoomSceneLayerAlphaMode): boolean {
  return alphaMode !== "opaque-rgb";
}

/**
 * Translate the asset-ledger alpha vocabulary to Pixi's upload vocabulary.
 * `blend` describes the compositor treatment of straight RGBA pixels; it is
 * not a Pixi blendMode and therefore uses the same upload path as straight
 * RGBA. The node remains presentation-only and does not mutate blendMode.
 */
export function resolveRoomSceneLayerUploadAlphaMode(
  alphaMode: RoomSceneLayerAlphaMode | null | undefined,
): RoomSceneLayerUploadAlphaMode | null {
  if (alphaMode === "premultiplied-rgba") return "premultiplied-alpha";
  if (alphaMode === "straight-rgba" || alphaMode === "blend") {
    return "premultiply-alpha-on-upload";
  }
  if (alphaMode === "opaque-rgb") return "no-premultiply-alpha";
  return null;
}

function hasUsableTexturePixels(texture: Texture): boolean {
  return !texture.destroyed
    && !texture.source.destroyed
    && hasPositiveInteger(texture.source.pixelWidth)
    && hasPositiveInteger(texture.source.pixelHeight);
}

function matchesRoomSceneLayerSourceSize(
  texture: Texture,
  sourceSize: Readonly<{ width: number; height: number }>,
): boolean {
  return texture.source.pixelWidth === sourceSize.width
    && texture.source.pixelHeight === sourceSize.height;
}

/**
 * Resolve the release gate before a caller creates or mounts an independent
 * Room scene node. The canonical poster deliberately does not use this gate:
 * it is the explicit D0 fallback/base, not a separable raster layer.
 */
export function resolveRoomSceneLayerEligibility(
  source: RoomSceneLayerSource | null | undefined,
  options: Readonly<{ allowOpaque?: boolean }> = {},
): RoomSceneLayerEligibility {
  if (
    !source
    || !hasText(source.assetId)
    || !hasText(source.path)
    || !hasPositiveInteger(source.sourceSize?.width)
    || !hasPositiveInteger(source.sourceSize?.height)
    || !["straight-rgba", "premultiplied-rgba", "blend", "opaque-rgb"].includes(source.alphaMode)
    || typeof source.reviewStatus !== "string"
    || typeof source.releaseApproval !== "boolean"
  ) {
    return { enabled: false, reason: "invalid-source" };
  }
  if (!hasTransparentAlpha(source.alphaMode) && !options.allowOpaque) {
    return { enabled: false, reason: "opaque-layer" };
  }
  if (source.reviewStatus.trim().toLowerCase() !== "approved") {
    return { enabled: false, reason: "review-not-approved" };
  }
  if (!source.releaseApproval) {
    return { enabled: false, reason: "release-not-approved" };
  }
  return { enabled: true, reason: "eligible" };
}

/**
 * Resolve the canonical-world placement gate independently from the asset
 * approval gate. The returned registration is later used as the only source
 * of Sprite position, size and anchor so callers cannot render a different
 * rectangle than the one they validated.
 */
export function resolveRoomSceneLayerRegistrationEligibility(
  registration: RoomSceneLayerRegistration | null | undefined,
): RoomSceneLayerEligibility {
  if (!registration) return { enabled: false, reason: "invalid-registration" };
  const rect = resolveRoomSceneLayerRegistrationRect(
    registration.position,
    registration.size,
    registration.anchor,
  );
  if (!rect) return { enabled: false, reason: "invalid-registration" };
  if (!isRoomSceneLayerRegistrationWithinWorld(
    registration.position,
    registration.size,
    registration.anchor,
  )) {
    return { enabled: false, reason: "registration-out-of-bounds" };
  }
  return { enabled: true, reason: "eligible" };
}

/**
 * Create a presentation-only node only after the source gate passes.
 * `depth` is carried in the input for call-site clarity; mounting remains the
 * responsibility of the host's D0–D6 node registry. The texture is always
 * caller-owned and is never destroyed by this factory.
 */
export function createRoomSceneLayerNode(
  options: RoomSceneLayerNodeOptions | null | undefined,
): RoomSceneLayerNodeResult {
  const eligibility = resolveRoomSceneLayerEligibility(options?.source, {
    allowOpaque: options?.depth === "D0",
  });
  if (!options || !eligibility.enabled) return { eligibility, node: null };

  const registrationEligibility = resolveRoomSceneLayerRegistrationEligibility(options.registration);
  if (!registrationEligibility.enabled) {
    return { eligibility: registrationEligibility, node: null };
  }

  if (!options.texture || !hasUsableTexturePixels(options.texture)) {
    return {
      eligibility: { enabled: false, reason: "invalid-source" },
      node: null,
    };
  }

  if (!matchesRoomSceneLayerSourceSize(options.texture, options.source.sourceSize)) {
    return {
      eligibility: { enabled: false, reason: "source-size-mismatch" },
      node: null,
    };
  }

  const node = createScenePixiTextureNode({
    texture: options.texture,
    label: options.node?.label ?? `room-scene-layer:${options.source.assetId}`,
    position: options.registration.position,
    anchor: options.registration.anchor,
    size: options.registration.size,
    alpha: options.node?.alpha,
    visible: options.node?.visible,
  });
  node.eventMode = "none";
  node.interactiveChildren = false;
  return { eligibility, node };
}

/** Current Room production slice intentionally has no independent raster layers. */
export const ROOM_SCENE_INDEPENDENT_LAYER_COUNT = 0 as const;

/** Stable diagnostic label shared by capture and future layer integrations. */
export const ROOM_SCENE_LAYER_POLICY = "approved-transparent-raster-only" as const;
