/**
 * 星图本地视口快照（文档 16 §15.6）。
 *
 * 视觉坐标（zoom/offset/selected）只保存在设备本地，以最近保存 + TTL 语义
 * 恢复；像素坐标永不进入服务端学习事实。每设备最多 50 条、默认 TTL 7 天。
 * 快照缺失/过期/布局版本不兼容时由调用方确定性聚焦目标节点。
 */

export const VIEWPORT_SNAPSHOT_KEY = "star-map:viewport:v1";
export const VIEWPORT_LAYOUT_VERSION = "1";
export const VIEWPORT_SNAPSHOT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const VIEWPORT_SNAPSHOT_MAX = 50;

export type UnderstandingLensKind = "current_target" | "evidence" | "provenance" | "issues";

export interface LocalGraphViewportSnapshotV1 {
  version: 1;
  userId: string;
  workspaceId: string;
  deviceSessionId: string;
  /** 发起时未知则为 null（创建 Run 后返回时按最近快照恢复）。 */
  runId: string | null;
  layoutVersion: string;
  zoom: number;
  offsetX: number;
  offsetY: number;
  selectedNode: { kind: string; id: string } | null;
  lens: UnderstandingLensKind;
  filter: { showArchived: boolean };
  savedAt: string;
  expiresAt: string;
}

export interface ViewportLike {
  zoom: number;
  offsetX: number;
  offsetY: number;
}

function readAll(storage: Pick<Storage, "getItem" | "setItem">): LocalGraphViewportSnapshotV1[] {
  try {
    const raw = storage.getItem(VIEWPORT_SNAPSHOT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is LocalGraphViewportSnapshotV1 => {
      if (!item || typeof item !== "object") return false;
      const entry = item as Record<string, unknown>;
      return entry.version === 1
        && typeof entry.zoom === "number"
        && typeof entry.offsetX === "number"
        && typeof entry.offsetY === "number"
        && typeof entry.savedAt === "string"
        && typeof entry.expiresAt === "string";
    });
  } catch {
    return [];
  }
}

function writeAll(storage: Pick<Storage, "getItem" | "setItem">, entries: LocalGraphViewportSnapshotV1[]): void {
  try {
    storage.setItem(VIEWPORT_SNAPSHOT_KEY, JSON.stringify(entries));
  } catch {
    // localStorage 满/不可用：静默丢弃（快照只是恢复增强，不阻塞学习）。
  }
}

function notExpired(entry: LocalGraphViewportSnapshotV1, now: number): boolean {
  const expiresAt = new Date(entry.expiresAt).getTime();
  return Number.isFinite(expiresAt) && expiresAt > now;
}

/** 保存一条快照（同 runId 覆盖；裁剪到上限；过期项清理）。 */
export function saveViewportSnapshot(
  storage: Pick<Storage, "getItem" | "setItem">,
  input: Omit<LocalGraphViewportSnapshotV1, "version" | "savedAt" | "expiresAt" | "layoutVersion">,
): void {
  const now = Date.now();
  const entries = readAll(storage).filter((entry) => notExpired(entry, now));
  const next: LocalGraphViewportSnapshotV1 = {
    version: 1,
    layoutVersion: VIEWPORT_LAYOUT_VERSION,
    savedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + VIEWPORT_SNAPSHOT_TTL_MS).toISOString(),
    userId: input.userId,
    workspaceId: input.workspaceId,
    deviceSessionId: input.deviceSessionId,
    runId: input.runId,
    zoom: input.zoom,
    offsetX: input.offsetX,
    offsetY: input.offsetY,
    selectedNode: input.selectedNode,
    lens: input.lens,
    filter: input.filter,
  };
  const withoutSameRun = input.runId
    ? entries.filter((entry) => entry.runId !== input.runId)
    : entries;
  withoutSameRun.push(next);
  writeAll(storage, withoutSameRun.slice(-VIEWPORT_SNAPSHOT_MAX));
}

/** 读取指定 runId 的快照（过期/缺失返回 null）。 */
export function loadViewportSnapshotForRun(
  storage: Pick<Storage, "getItem" | "setItem">,
  runId: string,
): LocalGraphViewportSnapshotV1 | null {
  const now = Date.now();
  return readAll(storage).find((entry) => entry.runId === runId && notExpired(entry, now)) ?? null;
}

/** 读取最近一条未过期快照（savedAt 相同时取最后插入的）。 */
export function loadLatestViewportSnapshot(
  storage: Pick<Storage, "getItem" | "setItem">,
): LocalGraphViewportSnapshotV1 | null {
  const now = Date.now();
  const entries = readAll(storage).filter((entry) => notExpired(entry, now));
  if (entries.length === 0) return null;
  return entries.reduce((latest, entry) => (
    entry.savedAt >= latest.savedAt ? entry : latest
  ));
}

/** 清理过期快照（返回是否清理了任何条目）。 */
export function clearExpiredViewportSnapshots(storage: Pick<Storage, "getItem" | "setItem">): boolean {
  const now = Date.now();
  const entries = readAll(storage);
  const remaining = entries.filter((entry) => notExpired(entry, now));
  if (remaining.length === entries.length) return false;
  writeAll(storage, remaining);
  return true;
}
