import type { RoomSceneLayerManifestEntry } from "../media/learning-room-manifest";
import {
  isValidSceneDepthChildOrder,
  sceneDepthBandIndex,
} from "./scene-depth";
import type { RoomSceneLayerBlockReason } from "./room-scene-layer-policy";

export type RoomSceneLayerAuditStatus = "mounted" | "blocked" | "failed";

export type RoomSceneLayerAuditReason =
  | "mounted"
  | RoomSceneLayerBlockReason
  | "unsupported-anchor"
  | "upload-mode-unavailable"
  | "texture-load-failed"
  | "node-mount-failed"
  | "runtime-failed"
  | "cancelled";

export type RoomSceneLayerAuditRecord = Readonly<{
  readonly assetId: string;
  readonly theme: RoomSceneLayerManifestEntry["theme"];
  readonly depth: RoomSceneLayerManifestEntry["depth"];
  readonly order: RoomSceneLayerManifestEntry["order"];
  readonly status: RoomSceneLayerAuditStatus;
  readonly reason: RoomSceneLayerAuditReason;
}>;

export type RoomSceneLayerAuditIdentity = Readonly<{
  readonly assetId: string;
  readonly theme: RoomSceneLayerManifestEntry["theme"];
  readonly depth: RoomSceneLayerManifestEntry["depth"];
  readonly order: RoomSceneLayerManifestEntry["order"];
}>;

export function compareRoomSceneLayerEntries(
  left: Pick<RoomSceneLayerManifestEntry, "assetId" | "theme" | "depth" | "order">,
  right: Pick<RoomSceneLayerManifestEntry, "assetId" | "theme" | "depth" | "order">,
): number {
  const depthDelta = sceneDepthBandIndex(left.depth) - sceneDepthBandIndex(right.depth);
  if (depthDelta !== 0) return depthDelta;
  const orderDelta = left.order - right.order;
  if (orderDelta !== 0) return orderDelta;
  const themeDelta = left.theme.localeCompare(right.theme);
  if (themeDelta !== 0) return themeDelta;
  return left.assetId.localeCompare(right.assetId);
}

const ROOM_SCENE_LAYER_THEMES = new Set<RoomSceneLayerAuditIdentity["theme"]>(["day", "night"]);
const ROOM_SCENE_LAYER_DEPTHS = new Set<RoomSceneLayerAuditIdentity["depth"]>([
  "D1",
  "D2",
  "D3",
  "D4",
  "D5",
  "D6",
]);
const ROOM_SCENE_LAYER_BLOCK_REASONS = new Set<RoomSceneLayerAuditReason>([
  "invalid-source",
  "opaque-layer",
  "review-not-approved",
  "release-not-approved",
  "source-size-mismatch",
  "invalid-registration",
  "registration-out-of-bounds",
  "unsupported-anchor",
  "upload-mode-unavailable",
]);
const ROOM_SCENE_LAYER_FAILURE_REASONS = new Set<RoomSceneLayerAuditReason>([
  "texture-load-failed",
  "node-mount-failed",
  "runtime-failed",
  "cancelled",
]);

export type RoomSceneLayerAuditSummary = Readonly<{
  readonly candidates: number;
  readonly mounted: number;
  readonly blocked: number;
  readonly failed: number;
}>;

export function summarizeRoomSceneLayerAudit(
  audit: readonly RoomSceneLayerAuditRecord[],
): RoomSceneLayerAuditSummary {
  return {
    candidates: audit.length,
    mounted: audit.filter((entry) => entry.status === "mounted").length,
    blocked: audit.filter((entry) => entry.status === "blocked").length,
    failed: audit.filter((entry) => entry.status === "failed").length,
  };
}

export function isRoomSceneLayerAuditRecord(
  value: unknown,
): value is RoomSceneLayerAuditRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<RoomSceneLayerAuditRecord>;
  if (
    typeof record.assetId !== "string"
    || record.assetId.trim().length === 0
    || !ROOM_SCENE_LAYER_THEMES.has(record.theme as RoomSceneLayerAuditIdentity["theme"])
    || !ROOM_SCENE_LAYER_DEPTHS.has(record.depth as RoomSceneLayerAuditIdentity["depth"])
    || !isValidSceneDepthChildOrder(record.order)
  ) {
    return false;
  }
  if (record.status === "mounted") return record.reason === "mounted";
  if (record.status === "blocked") return ROOM_SCENE_LAYER_BLOCK_REASONS.has(record.reason as RoomSceneLayerAuditReason);
  if (record.status === "failed") return ROOM_SCENE_LAYER_FAILURE_REASONS.has(record.reason as RoomSceneLayerAuditReason);
  return false;
}

export function serializeRoomSceneLayerAudit(
  audit: readonly RoomSceneLayerAuditRecord[],
): string {
  return JSON.stringify(audit);
}

export function serializeRoomSceneLayerIdentities(
  entries: readonly Pick<RoomSceneLayerManifestEntry, "assetId" | "theme" | "depth" | "order">[],
): string {
  return JSON.stringify(entries.map(({ assetId, theme, depth, order }) => ({
    assetId,
    theme,
    depth,
    order,
  })));
}

export function isRoomSceneLayerAuditAligned(
  audit: readonly RoomSceneLayerAuditRecord[],
  identities: readonly RoomSceneLayerAuditIdentity[],
): boolean {
  if (audit.length !== identities.length) return false;
  const identityKeys = identities.map((entry) => JSON.stringify([
    entry.assetId,
    entry.theme,
    entry.depth,
    entry.order,
  ]));
  if (new Set(identityKeys).size !== identityKeys.length) return false;
  return audit.every((entry, index) => (
    JSON.stringify([entry.assetId, entry.theme, entry.depth, entry.order]) === identityKeys[index]
  ));
}
