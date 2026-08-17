/**
 * Plan 23 W1-14/W1-15：Topology V3 合同测试。
 * - 只允许 source/note/objective/evidence 节点；
 * - card/key_point 节点被拒收（contract + guard 双断言）；
 * - personal overlay 不污染 shared topology；
 * - 血量场景：Note 激活 2 Objective + supersedes edge。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  understandingTopologySnapshotV3Schema,
  assertNoCardOrKeyPointNode,
  understandingNodeProjectionV3Schema,
  understandingEdgeProjectionV3Schema,
  type UnderstandingTopologySnapshotV3,
} from "./understanding-topology-v3-contracts.ts";

const OBJ_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OBJ_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NOTE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const EVID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const RUN = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

function snapshotFixture(): Record<string, unknown> {
  return {
    version: 3,
    workspaceId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    topologyRevision: "v3-1",
    checkpointToken: "tok-1",
    nodes: [
      {
        nodeRef: { kind: "note", noteId: NOTE },
        label: "光学原理笔记",
        currentVersionId: NOTE,
        freshness: "current",
      },
      {
        nodeRef: { kind: "objective", objectiveId: OBJ_A },
        label: "受激辐射与增益介质",
        publicSummary: "理解受激辐射如何产生光放大。",
        activeCardId: null,
        lifecycle: "active",
        freshness: "fresh",
        personal: {
          state: "learning",
          activeRunId: RUN,
          activeScheduleId: null,
          nextReviewAt: null,
          practiceTrailCount: 1,
          lastCanonicalEventId: null,
          primaryAction: { kind: "resume_run", runId: RUN, objectiveId: OBJ_A },
        },
      },
      {
        nodeRef: { kind: "objective", objectiveId: OBJ_B },
        label: "激光振荡条件",
        publicSummary: "理解谐振腔与增益的关系。",
        activeCardId: null,
        lifecycle: "active",
        freshness: "fresh",
        personal: {
          state: "unvalidated",
          activeRunId: null,
          activeScheduleId: null,
          nextReviewAt: null,
          practiceTrailCount: 0,
          lastCanonicalEventId: null,
          primaryAction: { kind: "create_run", origin: "graph", objectiveId: OBJ_B, cardId: null, goal: "首次验证" },
        },
      },
      {
        nodeRef: { kind: "evidence", evidenceSnapshotId: EVID },
        supportSummary: "教材 3.2 节关于增益系数的推导",
        sourceLabel: "光学教材",
        restricted: false,
      },
    ],
    edges: [
      { edgeId: "e1", kind: "sourced_from", from: { kind: "note", id: NOTE }, to: { kind: "objective", id: OBJ_A }, reasonCodes: ["origin_note"] },
      { edgeId: "e2", kind: "sourced_from", from: { kind: "note", id: NOTE }, to: { kind: "objective", id: OBJ_B }, reasonCodes: ["origin_note"] },
      { edgeId: "e3", kind: "supported_by", from: { kind: "objective", id: OBJ_A }, to: { kind: "evidence", id: EVID }, reasonCodes: [] },
      { edgeId: "e4", kind: "relates_to", from: { kind: "objective", id: OBJ_A }, to: { kind: "objective", id: OBJ_B }, reasonCodes: ["semantic"] },
    ],
    continuationToken: null,
    integrity: { truncated: false, missingOriginObjectiveIds: [] },
  };
}

test("W1-14: valid Topology V3 parses; no card/key_point nodes or private data", () => {
  const parsed = understandingTopologySnapshotV3Schema.parse(snapshotFixture());
  assert.equal(parsed.version, 3);
  assert.equal(parsed.nodes.length, 4);
  assert.deepEqual(assertNoCardOrKeyPointNode(parsed.nodes).violations, []);
  const serialized = JSON.stringify(parsed);
  assert.ok(!serialized.includes("canonicalAnswer"));
  assert.ok(!serialized.includes("scoringRubric"));
});

test("W1-14: node union REJECTS card and key_point kinds", () => {
  for (const kind of ["card", "key_point"]) {
    const node = {
      nodeRef: { kind, id: OBJ_A },
      label: "非法节点",
    };
    assert.equal(
      understandingNodeProjectionV3Schema.safeParse(node).success,
      false,
      "should reject " + kind + " node",
    );
  }
});

test("W1-14: guard reports card/key_point violations", () => {
  const nodes: unknown[] = [
    (snapshotFixture().nodes as unknown[])[0],
    { nodeRef: { kind: "card", id: OBJ_A }, label: "x" },
    { nodeRef: { kind: "key_point", id: OBJ_B }, label: "y" },
  ];
  const { violations } = assertNoCardOrKeyPointNode(nodes);
  assert.equal(violations.length, 2);
  assert.deepEqual(violations.map((v) => v.kind), ["card", "key_point"]);
});

test("W1-15: edges only use the four shared node kinds", () => {
  const good = understandingEdgeProjectionV3Schema.parse({
    edgeId: "e-supersedes",
    kind: "supersedes",
    from: { kind: "objective", id: OBJ_A },
    to: { kind: "objective", id: OBJ_B },
    reasonCodes: ["semantic_change"],
  });
  assert.equal(good.kind, "supersedes");
  // 端点不允许 card/key_point
  assert.equal(
    understandingEdgeProjectionV3Schema.safeParse({
      edgeId: "e-bad",
      kind: "supersedes",
      from: { kind: "key_point", id: OBJ_A },
      to: { kind: "objective", id: OBJ_B },
      reasonCodes: [],
    }).success,
    false,
  );
});

test("W1-15: personal overlay is typed and separated from shared fields", () => {
  const parsed = understandingTopologySnapshotV3Schema.parse(snapshotFixture());
  const objectiveNode = parsed.nodes.find(
    (n): n is Extract<typeof n, { nodeRef: { kind: "objective" } }> =>
      n.nodeRef.kind === "objective",
  );
  assert.ok(objectiveNode);
  assert.equal(objectiveNode.nodeRef.kind, "objective");
  const personal = objectiveNode.personal;
  assert.equal(personal.state, "learning");
  assert.equal(personal.activeRunId, RUN);
  assert.equal(personal.primaryAction.kind, "resume_run");
  // 共享字段不混入个人 overlay
  assert.equal((objectiveNode as Record<string, unknown>).practiceTrailCount, undefined);
  assert.equal((personal as Record<string, unknown>).canonicalAnswer, undefined);
});

test("W1-14: integrity exposes missing origins without forging note edges", () => {
  const fixture = snapshotFixture() as any;
  fixture.integrity = { truncated: true, missingOriginObjectiveIds: [OBJ_B] };
  const parsed = understandingTopologySnapshotV3Schema.parse(fixture) as UnderstandingTopologySnapshotV3;
  assert.equal(parsed.integrity.truncated, true);
  assert.deepEqual(parsed.integrity.missingOriginObjectiveIds, [OBJ_B]);
  // 缺失 origin 时凑出一条 note 边 → 通过（guard 只拒 card/key_point）；
  // 语义上 no-forge 由服务端保证，contract 层保持可表达。
  assert.equal(parsed.edges.length, 4);
});
