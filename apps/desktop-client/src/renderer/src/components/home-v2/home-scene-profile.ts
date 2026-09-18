import type { HomeV2CameraPreset } from "./home-v2";

export type HomeSceneTimeV1 = "day" | "dusk" | "night";
export type HomeSceneRegionId = "window" | "desk" | "shelf" | "rest";
export type HomeAmbientCueKind = "drift-x" | "rotate" | "page-lift" | "steam";

export type HomeSceneRect = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>;

export type HomeAmbientCueProfile = Readonly<{
  id: string;
  kind: HomeAmbientCueKind;
  /** Optional manifest asset controlled by the cue. Code-native steam omits it. */
  assetId?: string;
  durationMs: number;
  amplitude: number;
  baseline?: boolean;
  origin?: readonly [number, number];
}>;

export type HomeSceneRegionProfile = Readonly<{
  bounds: HomeSceneRect;
  targetAnchor: readonly [number, number];
}>;

export type HomeSceneProfileV1 = Readonly<{
  id: string;
  world: Readonly<{ width: 1672; height: 941 }>;
  floorPolygon: readonly (readonly [number, number])[];
  regions: Readonly<Record<HomeSceneRegionId, HomeSceneRegionProfile>>;
  objectAnchors: Readonly<Record<string, readonly [number, number]>>;
  cameraPresets: Readonly<Record<"wide" | HomeSceneRegionId, HomeV2CameraPreset>>;
  occlusionPolygons: readonly (readonly (readonly [number, number])[])[];
  ambientCues: Readonly<Record<HomeSceneRegionId, readonly HomeAmbientCueProfile[]>>;
}>;

const WORLD = Object.freeze({ width: 1672 as const, height: 941 as const });

export const LIGHTHOUSE_HOME_SCENE_PROFILE: HomeSceneProfileV1 = Object.freeze({
  id: "lighthouse-study-v1",
  world: WORLD,
  floorPolygon: Object.freeze([
    [344, 424],
    [1268, 420],
    [1510, 650],
    [1234, 920],
    [270, 920],
    [54, 650],
  ] as const),
  regions: Object.freeze({
    window: Object.freeze({ bounds: { x: 448, y: 0, width: 760, height: 430 }, targetAnchor: [836, 292] as const }),
    desk: Object.freeze({ bounds: { x: 0, y: 172, width: 438, height: 430 }, targetAnchor: [224, 400] as const }),
    shelf: Object.freeze({ bounds: { x: 1200, y: 54, width: 390, height: 530 }, targetAnchor: [1400, 410] as const }),
    rest: Object.freeze({ bounds: { x: 1190, y: 548, width: 482, height: 393 }, targetAnchor: [1450, 720] as const }),
  }),
  objectAnchors: Object.freeze({
    "desk-book": [174, 370] as const,
    "review-cards": [278, 350] as const,
    "desk-lamp": [225, 302] as const,
    "shelf-search": [1298, 250] as const,
    "magic-catalog": [1432, 340] as const,
    "shelf-notebook": [1324, 418] as const,
    "window-stars": [836, 174] as const,
    "rest-cushion": [1510, 686] as const,
  }),
  cameraPresets: Object.freeze({
    wide: { scale: 1, xPercent: 0, yPercent: 0 },
    desk: { scale: 1.252, xPercent: 12.5, yPercent: 1.5 },
    shelf: { scale: 1.272, xPercent: -13.5, yPercent: 1 },
    window: { scale: 1.202, xPercent: 0, yPercent: 7 },
    rest: { scale: 1.322, xPercent: -16, yPercent: -8 },
  }),
  occlusionPolygons: Object.freeze([
    Object.freeze([[0, 409], [68, 409], [104, 454], [104, 583], [54, 634], [0, 634]] as const),
    Object.freeze([[1226, 628], [1415, 632], [1447, 712], [1421, 867], [1244, 867], [1214, 720]] as const),
    Object.freeze([[1378, 600], [1672, 600], [1672, 941], [1344, 941], [1350, 794]] as const),
  ]),
  ambientCues: Object.freeze({
    window: Object.freeze([
      { id: "sea-drift", kind: "drift-x" as const, assetId: "HOME-LIGHTHOUSE-WATER", durationMs: 12_000, amplitude: 8, baseline: true },
      { id: "telescope-calibrate", kind: "rotate" as const, assetId: "HOME-LIGHTHOUSE-TELESCOPE", durationMs: 2_800, amplitude: 0.6 },
    ]),
    desk: Object.freeze([
      { id: "page-lift", kind: "page-lift" as const, assetId: "HOME-LIGHTHOUSE-DESK-PAGE", durationMs: 1_200, amplitude: 3 },
    ]),
    shelf: Object.freeze([
      { id: "catalog-breathe", kind: "rotate" as const, assetId: "HOME-LIGHTHOUSE-CATALOG-PAGE", durationMs: 2_600, amplitude: 1.2 },
    ]),
    rest: Object.freeze([
      { id: "cup-steam", kind: "steam" as const, durationMs: 2_600, amplitude: 6, origin: [1287, 681] as const },
    ]),
  }),
});

export function resolveHomeSceneTime(date: Date): HomeSceneTimeV1 {
  const minutes = date.getHours() * 60 + date.getMinutes();
  if (minutes >= 7 * 60 && minutes < 17 * 60 + 30) return "day";
  if (minutes >= 17 * 60 + 30 && minutes < 19 * 60 + 30) return "dusk";
  return "night";
}

export function homeSceneTimeForThemeMode(input: Readonly<{
  themeMode: "system" | "manual";
  theme: "day" | "night";
  now: Date;
}>): HomeSceneTimeV1 {
  return input.themeMode === "manual" ? input.theme : resolveHomeSceneTime(input.now);
}

export function validateHomeSceneProfile(profile: HomeSceneProfileV1): readonly string[] {
  const errors: string[] = [];
  if (!profile.id.trim()) errors.push("scene id is required");
  if (profile.world.width !== 1672 || profile.world.height !== 941) errors.push("world must be 1672x941");
  if (profile.floorPolygon.length < 3) errors.push("floor polygon requires at least three points");
  const inWorld = ([x, y]: readonly [number, number]) => Number.isFinite(x)
    && Number.isFinite(y)
    && x >= 0
    && y >= 0
    && x <= profile.world.width
    && y <= profile.world.height;
  if (!profile.floorPolygon.every(inWorld)) errors.push("floor polygon must stay inside the world");
  for (const region of ["window", "desk", "shelf", "rest"] as const) {
    const entry = profile.regions[region];
    if (!entry || entry.bounds.width <= 0 || entry.bounds.height <= 0 || !inWorld(entry.targetAnchor)) {
      errors.push(`region ${region} is invalid`);
    }
    const ids = new Set<string>();
    for (const cue of profile.ambientCues[region] ?? []) {
      if (!cue.id.trim() || ids.has(cue.id)) errors.push(`region ${region} has an invalid cue id`);
      ids.add(cue.id);
      if (!(cue.durationMs > 0) || !(cue.amplitude >= 0)) errors.push(`cue ${cue.id} has invalid timing`);
    }
  }
  return errors;
}

export function normalizedHomeFloorPolygon(
  profile: HomeSceneProfileV1 = LIGHTHOUSE_HOME_SCENE_PROFILE,
): readonly (readonly [number, number])[] {
  return profile.floorPolygon.map(([x, y]) => [x / profile.world.width, y / profile.world.height] as const);
}
