import assert from "node:assert/strict";
import { test } from "node:test";
import {
  TOPOLOGY_SNAPSHOT_DEFAULT_COLLECTION_LIMIT,
  TOPOLOGY_SNAPSHOT_MAX_COLLECTION_LIMIT,
  resolveTopologySnapshotCollectionLimit,
} from "../modules/understanding-v3/topology-repository.ts";

// 稳定 P0-2（2026-09-15 审计）：拓扑快照单集合上限护栏的解析点。
// 这里只覆盖"旋钮怎么解析"；"截断是否真的发生、是否确定"由
// integration-tests/understanding-topology-v3.integration.ts 用真实 Postgres 验证。
test("拓扑上限：未配置时取默认值，非法输入回落默认值", () => {
  assert.equal(resolveTopologySnapshotCollectionLimit(undefined), TOPOLOGY_SNAPSHOT_DEFAULT_COLLECTION_LIMIT);
  assert.equal(resolveTopologySnapshotCollectionLimit(""), TOPOLOGY_SNAPSHOT_DEFAULT_COLLECTION_LIMIT);
  assert.equal(resolveTopologySnapshotCollectionLimit("0"), TOPOLOGY_SNAPSHOT_DEFAULT_COLLECTION_LIMIT);
  assert.equal(resolveTopologySnapshotCollectionLimit("-5"), TOPOLOGY_SNAPSHOT_DEFAULT_COLLECTION_LIMIT);
  assert.equal(resolveTopologySnapshotCollectionLimit("abc"), TOPOLOGY_SNAPSHOT_DEFAULT_COLLECTION_LIMIT);
  // 非整数不取整而是回落：静默取整会让 ops 以为设的是 10 实际是 10.x 的截断语义。
  assert.equal(resolveTopologySnapshotCollectionLimit("10.5"), TOPOLOGY_SNAPSHOT_DEFAULT_COLLECTION_LIMIT);
});

test("拓扑上限：合法值原样生效，并夹在硬上限内", () => {
  assert.equal(resolveTopologySnapshotCollectionLimit("1"), 1);
  assert.equal(resolveTopologySnapshotCollectionLimit("250"), 250);
  assert.equal(resolveTopologySnapshotCollectionLimit(String(TOPOLOGY_SNAPSHOT_MAX_COLLECTION_LIMIT)), TOPOLOGY_SNAPSHOT_MAX_COLLECTION_LIMIT);
  assert.equal(
    resolveTopologySnapshotCollectionLimit(String(TOPOLOGY_SNAPSHOT_MAX_COLLECTION_LIMIT + 1)),
    TOPOLOGY_SNAPSHOT_MAX_COLLECTION_LIMIT,
  );
});
