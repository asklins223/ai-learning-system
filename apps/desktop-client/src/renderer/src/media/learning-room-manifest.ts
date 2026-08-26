import { useEffect, useState } from "react";
import { z } from "zod";
import {
  LEARNING_ROOM_ASSET_BASE_PATH,
  learningRoomManifestSchema,
  nonEmptyStringSchema,
  staticAssetPathSchema,
  type LearningRoomManifestV1,
} from "@ailearn/shared/desktop-ipc-contracts";

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
});

export type LearningRoomManifestSource = z.infer<typeof sourceManifestSchema>;
export type LearningRoomManifest = LearningRoomManifestSource & {
  readonly normalized: LearningRoomManifestV1;
};

const MANIFEST_PATH = `${LEARNING_ROOM_ASSET_BASE_PATH}/manifest.json`;

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

export function useLearningRoomManifest() {
  const [manifest, setManifest] = useState<LearningRoomManifest | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(MANIFEST_PATH, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`媒体清单请求失败（${response.status}）`);
        const value: unknown = await response.json();
        setManifest(parseLearningRoomManifest(value));
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setError(reason instanceof Error ? reason.message : "媒体清单未能载入");
      });
    return () => controller.abort();
  }, []);

  return { manifest, error };
}
