import { SCENE_WORLD, type ScenePoint } from "./scene-geometry";

export type SceneDepthBandId = "D0" | "D1" | "D2" | "D3" | "D4" | "D5" | "D6";

export type SceneDepthBand = {
  readonly id: SceneDepthBandId;
  readonly label: string;
  readonly parallaxFactor: number;
  readonly maxOffsetX: number;
  readonly maxOffsetY: number;
};

/**
 * The V1 2.5D base keeps a poster as the canonical surface while allowing
 * atmosphere, hotspots and approved foregrounds to move at different rates.
 */
export const SCENE_DEPTH_BANDS: readonly SceneDepthBand[] = Object.freeze([
  { id: "D0", label: "远景基底", parallaxFactor: 0.12, maxOffsetX: 2, maxOffsetY: 1 },
  { id: "D1", label: "窗景与建筑光", parallaxFactor: 0.32, maxOffsetX: 4, maxOffsetY: 2 },
  { id: "D2", label: "建筑固定层", parallaxFactor: 0.46, maxOffsetX: 5, maxOffsetY: 2.5 },
  { id: "D3", label: "家具中景", parallaxFactor: 0.68, maxOffsetX: 7, maxOffsetY: 3.5 },
  { id: "D4", label: "交互物件", parallaxFactor: 0.86, maxOffsetX: 9, maxOffsetY: 4.5 },
  { id: "D5", label: "光与空气", parallaxFactor: 1, maxOffsetX: 10, maxOffsetY: 5 },
  { id: "D6", label: "前景遮挡", parallaxFactor: 1.16, maxOffsetX: 12, maxOffsetY: 6 },
]);

/** Maximum explicit child order available inside one D0–D6 band. */
export const SCENE_DEPTH_CHILD_ORDER_MAX = 63 as const;

export function isValidSceneDepthChildOrder(value: unknown): value is number {
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= 0
    && value <= SCENE_DEPTH_CHILD_ORDER_MAX;
}

export function sceneDepthBandIndex(value: unknown): number {
  return SCENE_DEPTH_BANDS.findIndex((band) => band.id === value);
}

export const ROOM_SCENE_ANCHOR_IDS = Object.freeze([
  "room.notebook",
  "room.review",
  "room.lamp",
  "room.search",
  "room.graph",
  "room.ambient",
] as const);

export type SceneAnchorId = typeof ROOM_SCENE_ANCHOR_IDS[number];

export type SceneAnchor = {
  readonly id: SceneAnchorId;
  readonly point: ScenePoint;
  readonly label: string;
};

/** Center points are measured in the canonical 1672×941 room world. */
export const ROOM_SCENE_ANCHORS: Readonly<Record<SceneAnchorId, SceneAnchor>> = Object.freeze({
  "room.notebook": { id: "room.notebook", point: [836, 545.78], label: "研究册" },
  "room.review": { id: "room.review", point: [613.8, 517.55], label: "今日复习" },
  "room.lamp": { id: "room.lamp", point: [1068.8, 404.63], label: "灯光" },
  "room.search": { id: "room.search", point: [284.24, 376.4], label: "查找内容" },
  "room.graph": { id: "room.graph", point: [1300.8, 292.21], label: "理解星图" },
  "room.ambient": { id: "room.ambient", point: [1187.12, 357.58], label: "聆听窗外" },
});

export function isRoomSceneAnchorId(value: unknown): value is SceneAnchorId {
  return typeof value === "string"
    && ROOM_SCENE_ANCHOR_IDS.includes(value as SceneAnchorId)
    && Object.prototype.hasOwnProperty.call(ROOM_SCENE_ANCHORS, value);
}

export function sceneAnchorStyle(anchor: SceneAnchor): { left: string; top: string } {
  const percent = (value: number) => `${Number(value.toFixed(3))}%`;
  return {
    left: percent((anchor.point[0] / SCENE_WORLD.width) * 100),
    top: percent((anchor.point[1] / SCENE_WORLD.height) * 100),
  };
}
