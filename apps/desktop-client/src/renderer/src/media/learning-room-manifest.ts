import { useEffect, useState } from "react";
import { z } from "zod";
import {
  LEARNING_ROOM_ASSET_BASE_PATH,
  learningRoomManifestSchema,
  nonEmptyStringSchema,
  staticAssetPathSchema,
  type LearningRoomManifestV1,
} from "@ailearn/shared/desktop-ipc-contracts";
import {
  ROOM_SCENE_ANCHOR_IDS,
  SCENE_DEPTH_CHILD_ORDER_MAX,
} from "../scene/scene-depth";
import { isRoomSceneLayerRegistrationWithinWorld } from "../scene/scene-geometry";

export type ThemeMedia = {
  id: string;
  path: string;
  width: number;
  height: number;
  durationMs?: number;
  loop?: boolean;
  runtimeMuted?: boolean;
  reviewStatus?: string;
};

type SourceMedia = ThemeMedia & {
  sourcePath?: string;
  mimeType?: string;
  codec?: string;
  fps?: number;
  hasEmbeddedAudio?: boolean;
  sha256?: string;
  derivation?: {
    sourceWidth: number;
    sourceHeight: number;
    crop: { left: number; top: number; width: number; height: number };
    perspective: { topLeftY: number; topRightY: number; bottomLeftY: number; bottomRightY: number };
  };
};

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const roomSceneLayerManifestSchema = z.strictObject({
  assetId: nonEmptyStringSchema,
  path: staticAssetPathSchema,
  theme: z.enum(["day", "night"]),
  depth: z.enum(["D1", "D2", "D3", "D4", "D5", "D6"]),
  /** Ascending order within the same theme and depth band; larger is nearer. */
  order: z.number().int().min(0).max(SCENE_DEPTH_CHILD_ORDER_MAX),
  /** `null` means the layer is static in its depth band rather than anchor-bound. */
  anchorId: z.enum(ROOM_SCENE_ANCHOR_IDS).nullable(),
  sourceSize: z.strictObject({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
  registration: z.strictObject({
    position: z.tuple([z.number().finite(), z.number().finite()]),
    size: z.strictObject({
      width: z.number().finite().positive(),
      height: z.number().finite().positive(),
    }),
    anchor: z.tuple([
      z.number().finite().min(0).max(1),
      z.number().finite().min(0).max(1),
    ]),
  }),
  alphaMode: z.enum(["straight-rgba", "premultiplied-rgba", "blend", "opaque-rgb"]),
  reviewStatus: nonEmptyStringSchema,
  releaseApproval: z.boolean(),
}).superRefine((layer, context) => {
  if (!isRoomSceneLayerRegistrationWithinWorld(
    layer.registration.position,
    layer.registration.size,
    layer.registration.anchor,
  )) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["registration"],
      message: "Room layer registration must stay within the canonical room world.",
    });
  }
});

export type RoomSceneLayerManifestEntry = z.infer<typeof roomSceneLayerManifestSchema>;

const sourceMediaSchema = z
  .strictObject({
    id: nonEmptyStringSchema,
    path: staticAssetPathSchema,
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    durationMs: z.number().int().positive().optional(),
    loop: z.boolean().optional(),
    runtimeMuted: z.boolean().optional(),
    reviewStatus: nonEmptyStringSchema.optional(),
    sourcePath: staticAssetPathSchema.optional(),
    mimeType: nonEmptyStringSchema.optional(),
    codec: nonEmptyStringSchema.optional(),
    fps: z.number().positive().optional(),
    hasEmbeddedAudio: z.boolean().optional(),
    sha256: sha256Schema.optional(),
    derivation: z
      .strictObject({
        sourceWidth: z.number().int().positive(),
        sourceHeight: z.number().int().positive(),
        crop: z.strictObject({
          left: z.number().nonnegative(),
          top: z.number().nonnegative(),
          width: z.number().positive(),
          height: z.number().positive(),
        }),
        perspective: z.strictObject({
          topLeftY: z.number().nonnegative(),
          topRightY: z.number().nonnegative(),
          bottomLeftY: z.number().nonnegative(),
          bottomRightY: z.number().nonnegative(),
        }),
      })
      .optional(),
  });

const sourceManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: nonEmptyStringSchema,
  canonicalMode: z.literal("2d"),
  reviewStatus: nonEmptyStringSchema,
  basePath: z.literal(LEARNING_ROOM_ASSET_BASE_PATH),
  posters: z.strictObject({ day: sourceMediaSchema, night: sourceMediaSchema }),
  seatPosters: z.strictObject({ day: sourceMediaSchema, night: sourceMediaSchema }),
  entryPosters: z.strictObject({
    closed: z.strictObject({ day: sourceMediaSchema, night: sourceMediaSchema }),
    open: z.strictObject({ day: sourceMediaSchema, night: sourceMediaSchema }),
  }),
  authPosters: z.strictObject({ day: sourceMediaSchema, dusk: sourceMediaSchema, night: sourceMediaSchema }),
  registerPosters: z.strictObject({ day: sourceMediaSchema, dusk: sourceMediaSchema, night: sourceMediaSchema }),
  searchPosters: z.strictObject({ day: sourceMediaSchema, night: sourceMediaSchema }),
  searchForeground: z.strictObject({ day: sourceMediaSchema, night: sourceMediaSchema }),
  reviewPosters: z.strictObject({ day: sourceMediaSchema, night: sourceMediaSchema }),
  window: z.strictObject({
    mask: staticAssetPathSchema,
    registration: z.strictObject({
      left: z.number().min(0).max(1),
      top: z.number().min(0).max(1),
      width: z.number().positive().max(1),
      height: z.number().positive().max(1),
    }),
    day: sourceMediaSchema,
    night: sourceMediaSchema,
  }),
  onboarding: sourceMediaSchema.extend({ caption: nonEmptyStringSchema }),
  companion: sourceMediaSchema,
  graph: z.strictObject({
    poster: staticAssetPathSchema,
    motionImplementation: z.literal("code"),
  }),
  validation: z.strictObject({
    motionImplementation: z.literal("code"),
  }),
  sound: z.strictObject({
    ambientDay: staticAssetPathSchema.nullable(),
    ambientNight: staticAssetPathSchema.nullable(),
    onboardingVoice: staticAssetPathSchema.nullable(),
    onboardingCaptions: staticAssetPathSchema.nullable(),
  }),
  objects: z.record(nonEmptyStringSchema, staticAssetPathSchema),
  textures: z.record(nonEmptyStringSchema, staticAssetPathSchema),
  roomLayers: z.array(roomSceneLayerManifestSchema).max(64).default([]),
}).superRefine((value, context) => {
  const seenAssetIds = new Set<string>();
  const seenLayerPlacements = new Set<string>();
  value.roomLayers.forEach((layer, index) => {
    if (seenAssetIds.has(layer.assetId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["roomLayers", index, "assetId"],
        message: "duplicate Room layer asset id",
      });
    }
    seenAssetIds.add(layer.assetId);

    const placementKey = JSON.stringify([layer.theme, layer.depth, layer.order]);
    if (seenLayerPlacements.has(placementKey)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["roomLayers", index, "order"],
        message: "duplicate Room layer order within theme and depth band",
      });
    }
    seenLayerPlacements.add(placementKey);
  });
});

export type LearningRoomManifestSource = z.infer<typeof sourceManifestSchema>;
export type LearningRoomManifest = LearningRoomManifestSource & {
  readonly normalized: LearningRoomManifestV1;
};

export type DoorEntryAssetUrls = Readonly<{
  closed: string;
  home: string;
}>;

const MANIFEST_PATH = `${LEARNING_ROOM_ASSET_BASE_PATH}/manifest.json`;
let manifestCache: LearningRoomManifest | null = null;
let manifestPromise: Promise<LearningRoomManifest> | null = null;

function addAsset(assets: Record<string, string>, key: string, path: string): void {
  if (assets[key] !== undefined) throw new Error(`重复媒体资产键：${key}`);
  assets[key] = staticAssetPathSchema.parse(path);
}

export function normalizeLearningRoomManifest(
  source: LearningRoomManifestSource,
): LearningRoomManifestV1 {
  const assets: Record<string, string> = {};
  addAsset(assets, "posters.day", source.posters.day.path);
  addAsset(assets, "posters.night", source.posters.night.path);
  addAsset(assets, "seatPosters.day", source.seatPosters.day.path);
  addAsset(assets, "seatPosters.night", source.seatPosters.night.path);
  addAsset(assets, "entryPosters.closed.day", source.entryPosters.closed.day.path);
  addAsset(assets, "entryPosters.closed.night", source.entryPosters.closed.night.path);
  addAsset(assets, "entryPosters.open.day", source.entryPosters.open.day.path);
  addAsset(assets, "entryPosters.open.night", source.entryPosters.open.night.path);
  addAsset(assets, "authPosters.day", source.authPosters.day.path);
  addAsset(assets, "authPosters.dusk", source.authPosters.dusk.path);
  addAsset(assets, "authPosters.night", source.authPosters.night.path);
  addAsset(assets, "registerPosters.day", source.registerPosters.day.path);
  addAsset(assets, "registerPosters.dusk", source.registerPosters.dusk.path);
  addAsset(assets, "registerPosters.night", source.registerPosters.night.path);
  addAsset(assets, "searchPosters.day", source.searchPosters.day.path);
  addAsset(assets, "searchPosters.night", source.searchPosters.night.path);
  addAsset(assets, "searchForeground.day", source.searchForeground.day.path);
  addAsset(assets, "searchForeground.night", source.searchForeground.night.path);
  addAsset(assets, "reviewPosters.day", source.reviewPosters.day.path);
  addAsset(assets, "reviewPosters.night", source.reviewPosters.night.path);
  addAsset(assets, "window.mask", source.window.mask);
  addAsset(assets, "window.day", source.window.day.path);
  addAsset(assets, "window.night", source.window.night.path);
  addAsset(assets, "onboarding", source.onboarding.path);
  addAsset(assets, "companion", source.companion.path);
  addAsset(assets, "graph.poster", source.graph.poster);
  if (source.sound.ambientDay) addAsset(assets, "sound.ambientDay", source.sound.ambientDay);
  if (source.sound.ambientNight) addAsset(assets, "sound.ambientNight", source.sound.ambientNight);
  if (source.sound.onboardingVoice) addAsset(assets, "sound.onboardingVoice", source.sound.onboardingVoice);
  if (source.sound.onboardingCaptions) addAsset(assets, "sound.onboardingCaptions", source.sound.onboardingCaptions);
  for (const [key, path] of Object.entries(source.objects)) addAsset(assets, `objects.${key}`, path);
  for (const [key, path] of Object.entries(source.textures)) addAsset(assets, `textures.${key}`, path);
  source.roomLayers.forEach((layer, index) => addAsset(assets, `roomLayers.${index}`, layer.path));

  return learningRoomManifestSchema.parse({
    version: 1,
    schemaVersion: 1,
    id: source.id,
    canonicalMode: source.canonicalMode,
    basePath: LEARNING_ROOM_ASSET_BASE_PATH,
    assets,
  });
}

export function parseLearningRoomManifest(value: unknown): LearningRoomManifest {
  const source = sourceManifestSchema.parse(value);
  return Object.assign(source, { normalized: normalizeLearningRoomManifest(source) });
}

export function mediaAssetUrl(manifest: LearningRoomManifest, path: string): string {
  const safePath = staticAssetPathSchema.parse(path);
  if (!Object.values(manifest.normalized.assets).includes(safePath)) {
    throw new Error("媒体资产未登记在 learning-room manifest 中");
  }
  return `${LEARNING_ROOM_ASSET_BASE_PATH}/${safePath}`;
}

export function resolveDoorEntryAssetUrls(
  manifest: LearningRoomManifest,
  theme: "day" | "night",
): DoorEntryAssetUrls {
  return {
    closed: mediaAssetUrl(manifest, manifest.entryPosters.closed[theme].path),
    home: mediaAssetUrl(manifest, manifest.posters[theme].path),
  };
}

function loadLearningRoomManifest(): Promise<LearningRoomManifest> {
  if (manifestCache) return Promise.resolve(manifestCache);
  if (!manifestPromise) {
    manifestPromise = fetch(MANIFEST_PATH)
      .then(async (response) => {
        if (!response.ok) throw new Error(`媒体清单请求失败（${response.status}）`);
        const value: unknown = await response.json();
        const parsed = parseLearningRoomManifest(value);
        manifestCache = parsed;
        return parsed;
      })
      .finally(() => {
        manifestPromise = null;
      });
  }
  return manifestPromise;
}

export function useLearningRoomManifest() {
  const [manifest, setManifest] = useState<LearningRoomManifest | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void loadLearningRoomManifest()
      .then((value) => {
        if (active) setManifest(value);
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : "媒体清单未能载入");
      });
    return () => {
      active = false;
    };
  }, []);

  return { manifest, error };
}
