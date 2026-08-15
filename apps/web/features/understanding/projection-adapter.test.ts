/**
 * projection → UnderstandingGraph 适配纯函数测试（文档 16 §15.2 切流）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { projectionToUnderstandingGraph } from "./projection-adapter";

const UUID_A = "00000000-0000-4000-8000-00000000000a";
const UUID_B = "00000000-0000-4000-8000-00000000000b";
const UUID_C = "00000000-0000-4000-8000-00000000000c";
const UUID_K1 = "00000000-0000-4000-8000-0000000000k1";
const UUID_K2 = "00000000-0000-4000-8000-0000000000k2";

function sampleProjection() {
  return {
    version: 2,
    generatedAt: "2026-08-14T00:00:00.000Z",
    checkpoint: null,
    planes: { shared: "workspace_owned", personal: "user_private" },
    request: { lens: "current_target", filter: null, targetKeyPointId: null, routePlanId: null },
    slice: { kind: "workspace_map", continuationToken: null },
    nodes: [
      {
        nodeRef: { kind: "source", sourceId: UUID_A },
        label: "资料来源",
        shared: { archived: false, sourceFingerprint: "" },
        personal: null,
      },
      {
        nodeRef: { kind: "note", noteId: UUID_B },
        label: "笔记标题",
        shared: { archived: false, sourceFingerprint: "" },
        personal: null,
      },
      {
        nodeRef: { kind: "card", cardId: UUID_C },
        label: "学习卡标题",
        shared: { archived: false, sourceFingerprint: "" },
        personal: {
          state: "fragile",
          nextReviewAt: "2026-08-15T00:00:00.000Z",
          activeScheduleId: UUID_A,
          lastCanonicalEventId: "canonical:1",
          practiceTrailCount: 2,
        },
      },
      {
        nodeRef: { kind: "key_point", keyPointId: UUID_K1 },
        label: "要点一",
        shared: { archived: false, sourceFingerprint: "" },
        personal: { state: "stable", nextReviewAt: null, activeScheduleId: null, lastCanonicalEventId: "canonical:2", practiceTrailCount: 0 },
      },
      {
        nodeRef: { kind: "key_point", keyPointId: UUID_K2 },
        label: "要点二",
        shared: { archived: false, sourceFingerprint: "" },
        personal: { state: "unknown", nextReviewAt: null, activeScheduleId: null, lastCanonicalEventId: null, practiceTrailCount: 0 },
      },
    ],
    edges: [
      { edgeId: "e1", from: { kind: "source", sourceId: UUID_A }, to: { kind: "note", noteId: UUID_B }, kind: "derived_from", provenanceHash: "h1" },
      { edgeId: "e2", from: { kind: "note", noteId: UUID_B }, to: { kind: "card", cardId: UUID_C }, kind: "derived_from", provenanceHash: "h2" },
      { edgeId: "e3", from: { kind: "card", cardId: UUID_C }, to: { kind: "key_point", keyPointId: UUID_K1 }, kind: "contains", provenanceHash: "h3" },
      { edgeId: "e4", from: { kind: "card", cardId: UUID_C }, to: { kind: "key_point", keyPointId: UUID_K2 }, kind: "contains", provenanceHash: "h4" },
    ],
    currentTarget: null,
  };
}

test("完整投影 → 节点/边/层级/href 映射", () => {
  const graph = projectionToUnderstandingGraph(sampleProjection());
  assert.ok(graph);
  assert.equal(graph.nodes.length, 5);
  assert.equal(graph.edges.length, 4);

  const card = graph.nodes.find((n) => n.type === "card")!;
  assert.equal(card.id, `card:${UUID_C}`);
  assert.equal(card.label, "学习卡标题");
  assert.equal(card.href, `/cards/${UUID_C}`);
  // card 聚合 state：fragile → due_review。
  assert.equal(card.state, "due_review");
  assert.equal(card.nextReviewAt, "2026-08-15T00:00:00.000Z");

  const kp = graph.nodes.find((n) => n.entityId === UUID_K1)!;
  assert.equal(kp.state, "preliminary_understood"); // stable → preliminary_understood
  assert.equal(kp.href, `/cards/${UUID_C}`); // 由 contains 边推导
  assert.equal(kp.parentId, `card:${UUID_C}`);

  const note = graph.nodes.find((n) => n.type === "note")!;
  assert.equal(note.parentId, `source:${UUID_A}`);
  assert.equal(note.state, null);

  const source = graph.nodes.find((n) => n.type === "source")!;
  assert.equal(source.parentId, null);
  assert.equal(source.state, null);
});

test("note→card 边还原为 generated_from；card→kp 为 contains", () => {
  const graph = projectionToUnderstandingGraph(sampleProjection())!;
  const types = graph.edges.map((e) => e.type).sort();
  assert.deepEqual(types, ["contains", "contains", "derived_from", "generated_from"]);
});

test("非法输入 fail closed 返回 null", () => {
  assert.equal(projectionToUnderstandingGraph(null), null);
  assert.equal(projectionToUnderstandingGraph({}), null);
  assert.equal(projectionToUnderstandingGraph({ nodes: "x", edges: [] }), null);
  assert.equal(projectionToUnderstandingGraph(undefined), null);
});

test("unknown 状态映射 unseen；needs_repair 映射 misunderstood", () => {
  const projection = sampleProjection();
  const card = projection.nodes.find((n) => n.nodeRef.kind === "card")!;
  card.personal = { state: "needs_repair", nextReviewAt: null, activeScheduleId: null, lastCanonicalEventId: null, practiceTrailCount: 0 };
  const graph = projectionToUnderstandingGraph(projection)!;
  assert.equal(graph.nodes.find((n) => n.type === "card")!.state, "misunderstood");
  const kp2 = graph.nodes.find((n) => n.entityId === UUID_K2)!;
  assert.equal(kp2.state, "unseen");
});

test("投影元数据保留在 metadata（供详情页诚实降级）", () => {
  const graph = projectionToUnderstandingGraph(sampleProjection())!;
  const card = graph.nodes.find((n) => n.type === "card")!;
  assert.equal(card.metadata.projection, true);
  assert.equal(card.metadata.personalState, "fragile");
  assert.equal(card.metadata.practiceTrailCount, 2);
});

test("adapter：evidence 节点 + supports 边映射", () => {
  const projection = {
    version: 2,
    generatedAt: "2026-08-15T00:00:00.000Z",
    checkpoint: null,
    planes: { shared: "workspace_owned", personal: "user_private" },
    request: { lens: "current_target", filter: null, targetKeyPointId: null, routePlanId: null },
    slice: { kind: "workspace_map", continuationToken: null },
    nodes: [
      {
        nodeRef: { kind: "key_point", keyPointId: UUID_K1 },
        label: "要点一",
        shared: { archived: false, sourceFingerprint: "" },
        personal: { state: "unknown", nextReviewAt: null, activeScheduleId: null, lastCanonicalEventId: null, practiceTrailCount: 0 },
      },
      {
        nodeRef: { kind: "evidence", evidenceId: "ev-1" },
        label: "证据引用原文",
        shared: { archived: false, sourceFingerprint: "" },
        personal: null,
      },
    ],
    edges: [
      { edgeId: "e1", from: { kind: "evidence", evidenceId: "ev-1" }, to: { kind: "key_point", keyPointId: UUID_K1 }, kind: "supports", provenanceHash: "h1" },
    ],
  };
  const graph = projectionToUnderstandingGraph(projection);
  assert.ok(graph);
  const evidence = graph.nodes.find((node) => node.type === "evidence");
  assert.ok(evidence, "evidence 节点存在");
  assert.equal(evidence.entityId, "ev-1");
  assert.equal(evidence.label, "证据引用原文");
  const supports = graph.edges.find((edge) => edge.type === "supports");
  assert.ok(supports, "supports 边存在");
  assert.equal(supports.from, "evidence:ev-1");
  assert.equal(supports.to, `key_point:${UUID_K1}`);
});
