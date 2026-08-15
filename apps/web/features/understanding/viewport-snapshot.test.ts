/**
 * 星图本地视口快照纯函数测试（文档 16 §15.6）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clearExpiredViewportSnapshots,
  loadLatestViewportSnapshot,
  loadViewportSnapshotForRun,
  saveViewportSnapshot,
  VIEWPORT_SNAPSHOT_KEY,
  VIEWPORT_SNAPSHOT_MAX,
} from "./viewport-snapshot";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function memoryStorage(): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, value); },
  };
}
function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    userId: "u1",
    workspaceId: "w1",
    deviceSessionId: "d1",
    runId: null,
    zoom: 1.2,
    offsetX: 40,
    offsetY: -20,
    selectedNode: { kind: "key_point", id: "kp-1" },
    lens: "current_target" as const,
    filter: { showArchived: false },
    ...overrides,
  };
}

test("save + loadLatest 返回最近一条未过期快照", () => {
  const storage = memoryStorage();
  saveViewportSnapshot(storage, baseInput({ offsetX: 10 }));
  saveViewportSnapshot(storage, baseInput({ offsetX: 99 }));
  const latest = loadLatestViewportSnapshot(storage);
  assert.ok(latest);
  assert.equal(latest.offsetX, 99);
});

test("同 runId 覆盖，不产生重复条目", () => {
  const storage = memoryStorage();
  saveViewportSnapshot(storage, baseInput({ runId: "run-1", zoom: 1 }));
  saveViewportSnapshot(storage, baseInput({ runId: "run-1", zoom: 2 }));
  const forRun = loadViewportSnapshotForRun(storage, "run-1");
  assert.ok(forRun);
  assert.equal(forRun.zoom, 2);
  const all = JSON.parse(storage.map.get(VIEWPORT_SNAPSHOT_KEY) ?? "[]") as unknown[];
  assert.equal(all.length, 1);
});

test("过期快照不返回且可清理", () => {
  const storage = memoryStorage();
  saveViewportSnapshot(storage, baseInput());
  // 手动把 expiresAt 改到过去。
  const raw = JSON.parse(storage.map.get(VIEWPORT_SNAPSHOT_KEY) ?? "[]") as Array<{ expiresAt: string }>;
  raw[0].expiresAt = new Date(Date.now() - 1000).toISOString();
  storage.map.set(VIEWPORT_SNAPSHOT_KEY, JSON.stringify(raw));
  assert.equal(loadLatestViewportSnapshot(storage), null);
  assert.equal(clearExpiredViewportSnapshots(storage), true);
  assert.equal(loadLatestViewportSnapshot(storage), null);
});

test("超过上限裁剪到 VIEWPORT_SNAPSHOT_MAX", () => {
  const storage = memoryStorage();
  for (let i = 0; i < VIEWPORT_SNAPSHOT_MAX + 10; i += 1) {
    saveViewportSnapshot(storage, baseInput({ runId: `run-${i}`, offsetX: i }));
  }
  const all = JSON.parse(storage.map.get(VIEWPORT_SNAPSHOT_KEY) ?? "[]") as unknown[];
  assert.equal(all.length, VIEWPORT_SNAPSHOT_MAX);
  // 保留的是最近保存的（run-10..run-59）。
  const latest = loadLatestViewportSnapshot(storage);
  assert.ok(latest);
  assert.equal(latest.offsetX, VIEWPORT_SNAPSHOT_MAX + 9);
});

test("损坏数据 fail closed（返回 null，不抛错）", () => {
  const storage = memoryStorage();
  storage.map.set(VIEWPORT_SNAPSHOT_KEY, "{not-json");
  assert.equal(loadLatestViewportSnapshot(storage), null);
  assert.equal(loadViewportSnapshotForRun(storage, "run-x"), null);
  storage.map.set(VIEWPORT_SNAPSHOT_KEY, JSON.stringify([{ bad: true }]));
  assert.equal(loadLatestViewportSnapshot(storage), null);
});

test("restoreRun 无匹配时（发起时 runId 未知）返回 null，由调用方回退最近快照", () => {
  const storage = memoryStorage();
  saveViewportSnapshot(storage, baseInput({ runId: null }));
  assert.equal(loadViewportSnapshotForRun(storage, "run-created-later"), null);
  const latest = loadLatestViewportSnapshot(storage);
  assert.ok(latest);
  assert.equal(latest.runId, null);
});
