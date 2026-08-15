/**
 * projection-client 纯函数测试（文档 16 §15 客户端语义）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createLocalDeltaReceiptStore,
  mergeProjectionPages,
  parseProjectionResponse,
  shouldAnimateDelta,
  saveCheckpointToken,
  loadCheckpointToken,
} from "./projection-client";

function makeMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, value); },
    removeItem: (key) => { map.delete(key); },
    clear: () => { map.clear(); },
    key: (index) => [...map.keys()][index] ?? null,
    get length() { return map.size; },
  };
}

test("parseProjectionResponse：202 → pending（保持旧投影）；200 → ready + token", () => {
  assert.deepEqual(parseProjectionResponse({ status: "pending" }, 202), {
    status: "pending",
    checkpointToken: null,
    data: null,
    retryAfterMs: null,
  });
  const ready = parseProjectionResponse({
    version: 2,
    checkpoint: { token: "cp:v1:abc.def" },
    nodes: [],
  }, 200);
  assert.equal(ready.status, "ready");
  assert.equal(ready.checkpointToken, "cp:v1:abc.def");
  assert.equal((ready.data as { version?: number }).version, 2);
});

test("delta receipt：同设备同 changeSetId 只显影一次；TTL 语义由时间戳控制", () => {
  const storage = makeMemoryStorage();
  const store = createLocalDeltaReceiptStore(storage);
  const input = { userId: "u1", deviceSessionId: "d1", changeSetId: "cs:abc" };
  assert.equal(shouldAnimateDelta(store, input), true);
  store.mark("u1", "d1", "cs:abc");
  assert.equal(shouldAnimateDelta(store, input), false);
  // 换设备/换用户 → 各自独立。
  assert.equal(shouldAnimateDelta(store, { userId: "u1", deviceSessionId: "d2", changeSetId: "cs:abc" }), true);
  assert.equal(shouldAnimateDelta(store, { userId: "u2", deviceSessionId: "d1", changeSetId: "cs:abc" }), true);
  // 不同 changeSetId → 显影。
  assert.equal(shouldAnimateDelta(store, { userId: "u1", deviceSessionId: "d1", changeSetId: "cs:xyz" }), true);
});

test("checkpoint token 本地保存/读取（按 user 隔离）", () => {
  const storage = makeMemoryStorage();
  saveCheckpointToken(storage, "u1", "cp:v1:a.b");
  assert.equal(loadCheckpointToken(storage, "u1"), "cp:v1:a.b");
  assert.equal(loadCheckpointToken(storage, "u2"), null);
  saveCheckpointToken(storage, "u1", null);
  assert.equal(loadCheckpointToken(storage, "u1"), null);
});

const PAGE_NODE = (ref: unknown) => ({
  nodeRef: ref,
  label: "x",
  shared: { archived: false, sourceFingerprint: "" },
  personal: null,
});

function makePage(payload: Record<string, unknown>) {
  return {
    version: 2,
    generatedAt: "2026-08-14T00:00:00.000Z",
    checkpoint: { version: 1, token: "ck-1" },
    planes: { shared: "workspace_owned", personal: "user_private" },
    request: { lens: "current_target", filter: null, targetKeyPointId: null, routePlanId: null },
    slice: { kind: "workspace_map", continuationToken: null },
    nodes: [],
    edges: [],
    ...payload,
  };
}

test("mergeProjectionPages：跨页节点按 nodeRef 去重、边按 edgeId 去重", () => {
  const kp1 = PAGE_NODE({ kind: "key_point", keyPointId: "k1" });
  const kp2 = PAGE_NODE({ kind: "key_point", keyPointId: "k2" });
  const card = PAGE_NODE({ kind: "card", cardId: "c1" });
  const edge1 = { edgeId: "e1", from: { kind: "card", cardId: "c1" }, to: { kind: "key_point", keyPointId: "k1" }, kind: "contains", provenanceHash: "h1" };
  const edge2 = { edgeId: "e2", from: { kind: "card", cardId: "c1" }, to: { kind: "key_point", keyPointId: "k2" }, kind: "contains", provenanceHash: "h2" };
  const merged = mergeProjectionPages([
    makePage({ nodes: [card, kp1], edges: [edge1] }),
    makePage({ nodes: [kp2, kp1], edges: [edge2, edge1] }),
  ]) as { nodes: unknown[]; edges: unknown[]; slice: { continuationToken: unknown }; checkpoint: { token: string } };

  assert.ok(merged, "合并结果非空");
  assert.equal(merged.nodes.length, 3, "节点去重（card/kp1/kp2）");
  assert.equal(merged.edges.length, 2, "边去重（e1/e2）");
  assert.equal(merged.checkpoint.token, "ck-1");
  assert.equal(merged.slice.continuationToken, null, "合并后 continuation 收敛为 null");
});

test("mergeProjectionPages：checkpoint 取最后一页；slice.kind 保留", () => {
  const merged = mergeProjectionPages([
    makePage({ checkpoint: { version: 1, token: "ck-1" } }),
    makePage({ checkpoint: { version: 1, token: "ck-2" }, slice: { kind: "workspace_map", continuationToken: "tok" } }),
  ]) as { checkpoint: { token: string }; slice: { kind: string } };
  assert.equal(merged.checkpoint.token, "ck-2");
  assert.equal(merged.slice.kind, "workspace_map");
});

test("mergeProjectionPages：空输入 / 非法页 → null（fail closed）", () => {
  assert.equal(mergeProjectionPages([]), null);
  assert.equal(mergeProjectionPages([null]), null);
  assert.equal(mergeProjectionPages([{ version: 2, nodes: "bad", edges: [] }]), null);
  assert.equal(mergeProjectionPages([{ version: 2, nodes: [], edges: [] }, { nodes: [], edges: "bad" }]), null);
});
