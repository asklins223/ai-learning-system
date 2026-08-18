/**
 * 任务 07-6：理解星图两个数据平面与真实回写单测。
 *
 * 覆盖（验收，07-w6 任务 07-6）：
 * - 0 无事件点亮：只读交互（浏览/打开/停留/收藏/朗读/看过答案）恒为 0 投影
 *   变化；durable 节点必须能追溯 canonical validation/review outcome 事件；
 * - 重放同 hash：相同共享/个人事件流 → 相同投影与 hash；乱序 → 不同 hash；
 * - 两平面分离：共享知识真值（workspace-owned，canonical Publish + FK 血缘）
 *   与个人学习事实（user-private，重放）互不串扰；
 * - facet 可追合格 assessment：每条 facet 观测绑定 rubricItemId + 事件 hash；
 * - 时间耐久只有 canonical validation/review 改变（practice/assistance/seen
 *   不改变 durable）；
 * - 四透镜：关系透镜只展示确定性血缘（FK provenance）、问题透镜 Should flag
 *   控制可见性、当前目标透镜含建议路线、证据透镜含 exact/semantic support；
 * - 节点详情：到期/能力切面/最近验证/assistance cooldown 不进全图透镜；
 * - LOD：按当前目标/priority/gap/重要性保留，不随机取样；
 * - Scene 连线只是 Episode Response Artifact，不会自动创建共享边。
 *
 * 全部纯函数测试，不需要数据库。
 *
 * 说明：测试避免 `import type` 与直接 import @ailearn/shared（tsx@node20 下
 * 组合会挂起），类型一律用结构兼容的字面量/推断（TS 结构类型系统校验）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertSceneConnectionDoesNotPublishEdge,
  assertZeroEventLightUp,
  buildFourLensViews,
  buildNodeDetail,
  buildTwoPlaneView,
  evaluateReadOnlyInteraction,
  planNodeActions,
  replayPersonalPlane,
  replaySharedPlane,
  selectLodNodes,
} from "./star-map-projections.ts";

// ─── 测试数据（结构兼容的本地字面量类型，不 import type）────────────────────

type SharedNodeTypeLiteral = "source" | "note" | "card" | "key_point" | "evidence";
type FkLineageLiteral = {
  parentType: SharedNodeTypeLiteral;
  parentEntityId: string;
  fkName: string;
};
type PersonalEventTypeLiteral =
  | "validation.event"
  | "review.attempt"
  | "understanding.event"
  | "practice.trail"
  | "assistance.recorded"
  | "question.saved"
  | "trail.visibility";

function sharedPublish(
  sequence: number,
  nodeType: SharedNodeTypeLiteral,
  entityId: string,
  lineage: FkLineageLiteral | null,
  opts: Partial<{
    fingerprint: string;
    version: number;
    officialPriority: number | null;
    publishedAt: string;
  }> = {},
) {
  return {
    workspaceId: "ws-1",
    sequence,
    eventType: "shared.publish" as const,
    nodeType,
    entityId,
    lineage,
    fingerprint: opts.fingerprint ?? `fp-${entityId}`,
    version: opts.version ?? 1,
    officialPriority: opts.officialPriority ?? null,
    publishedAt: opts.publishedAt ?? "2026-08-08T00:00:00.000Z",
  };
}

function personalEvent(
  sequence: number,
  eventType: PersonalEventTypeLiteral,
  payload: Record<string, unknown>,
) {
  return { workspaceId: "ws-1", userId: "user-1", sequence, eventType, payload };
}

function validationEvent(sequence: number, keyPointId: string, outcome = "pass") {
  return personalEvent(sequence, "validation.event", {
    keyPointId,
    outcomeSummary: outcome,
    confidence: 85,
    occurredAt: "2026-08-08T01:00:00.000Z",
    facetSummaries: [
      {
        rubricItemId: `rubric-${keyPointId}-explain`,
        verdict: "covered",
        confidence: 80,
        keyPointId,
        facet: "explain",
      },
    ],
  });
}

function reviewEvent(sequence: number, keyPointId: string) {
  return personalEvent(sequence, "review.attempt", {
    keyPointId,
    outcome: "pass",
    outcomeSummary: "pass",
    confidence: 90,
    occurredAt: "2026-08-08T02:00:00.000Z",
    nextReviewAt: "2026-08-15T02:00:00.000Z",
  });
}

function practiceTrail(sequence: number, keyPointId: string) {
  return personalEvent(sequence, "practice.trail", {
    keyPointId,
    occurredAt: "2026-08-08T03:00:00.000Z",
  });
}

// ─── 0 无事件点亮 ───────────────────────────────────────────────────────────

describe("star-map-projections: 0 无事件点亮", () => {
  it("只读交互（浏览/打开/停留/收藏/朗读/看过答案）恒为 0 投影变化", () => {
    for (const action of ["view", "open", "dwell", "favorite", "read_aloud", "saw_answer"] as const) {
      const verdict = evaluateReadOnlyInteraction(action);
      assert.equal(verdict.lightsUpUnderstanding, false);
      assert.equal(verdict.changesProjection, false);
      assert.match(verdict.reasonCode, new RegExp(`read_only_${action}`));
    }
  });

  it("只有 canonical validation/review outcome 才使节点 durable（0 无事件点亮）", () => {
    // 仅 practice / assistance / seen（understanding）事件，无 canonical outcome
    const events = [
      practiceTrail(1, "kp-1"),
      personalEvent(2, "assistance.recorded", {
        keyPointId: "kp-1",
        assistanceLevel: "content_assisted",
      }),
      personalEvent(3, "understanding.event", {
        subjectType: "keyPoint",
        subjectId: "kp-1",
        action: "seen",
      }),
    ];
    const plane = replayPersonalPlane(events);
    assert.equal(plane.durability["kp-1"]?.durable ?? false, false);

    const check = assertZeroEventLightUp({ durability: plane.durability, events });
    assert.equal(check.valid, true);
    assert.deepEqual(check.violations, []);
  });

  it("durable 节点必须能追溯 canonical outcome 事件；无事件点亮即违反", () => {
    const events = [validationEvent(1, "kp-1"), reviewEvent(2, "kp-2")];
    const plane = replayPersonalPlane(events);
    assert.equal(plane.durability["kp-1"]?.durable, true);
    assert.equal(plane.durability["kp-2"]?.durable, true);

    const ok = assertZeroEventLightUp({ durability: plane.durability, events });
    assert.equal(ok.valid, true);

    // 手工构造一个无事件来源的 durable 状态 → 违反
    const bad = assertZeroEventLightUp({
      durability: {
        "kp-ghost": {
          keyPointId: "kp-ghost",
          durable: true,
          outcome: "pass",
          confidence: 100,
          validatedAt: null,
          reviewedAt: null,
          nextReviewAt: null,
          lastEventHash: null,
        },
      },
      events,
    });
    assert.equal(bad.valid, false);
    assert.deepEqual(bad.violations, ["kp-ghost"]);
  });

  it("只有 validation/review 改变时间耐久；seen/practice/assistance 不变", () => {
    const events = [
      personalEvent(1, "understanding.event", { subjectType: "keyPoint", subjectId: "kp-1", action: "seen" }),
      practiceTrail(2, "kp-1"),
      personalEvent(3, "assistance.recorded", { keyPointId: "kp-1" }),
      reviewEvent(4, "kp-1"),
    ];
    const plane = replayPersonalPlane(events);
    const durability = plane.durability["kp-1"]!;
    assert.equal(durability.durable, true);
    assert.equal(durability.reviewedAt, "2026-08-08T02:00:00.000Z");
    assert.equal(durability.nextReviewAt, "2026-08-15T02:00:00.000Z");
    // 只有事件 4 是 review：lastEventHash 必须可追溯（非空）
    assert.notEqual(durability.lastEventHash, null);
    // 前面 3 个事件（seen/practice/assistance）不应使 durable 翻真
    const early = replayPersonalPlane(events.slice(0, 3));
    assert.equal(early.durability["kp-1"]?.durable ?? false, false);
  });
});

// ─── 重放同 hash ────────────────────────────────────────────────────────────

describe("star-map-projections: 重放同 hash", () => {
  it("相同共享事件流重放得到相同节点/边/hash", () => {
    const events = [
      sharedPublish(1, "source", "src-1", null),
      sharedPublish(2, "note", "note-1", { parentType: "source", parentEntityId: "src-1", fkName: "notes.source_id" }),
      sharedPublish(3, "card", "card-1", { parentType: "note", parentEntityId: "note-1", fkName: "note_versions.note_id" }),
      sharedPublish(4, "key_point", "kp-1", { parentType: "card", parentEntityId: "card-1", fkName: "learning_cards_v2.objective_id" }),
      sharedPublish(5, "evidence", "ev-1", { parentType: "key_point", parentEntityId: "kp-1", fkName: "evidences.key_point_id" }),
    ];
    const a = replaySharedPlane(events);
    const b = replaySharedPlane(events.map((e) => ({ ...e })));
    assert.equal(a.hash, b.hash);
    assert.deepEqual(a.nodes, b.nodes);
    assert.deepEqual(a.edges, b.edges);
    // 四条 FK 血缘边全部生成
    assert.equal(Object.keys(a.edges).length, 4);
    const kinds = Object.values(a.edges).map((e) => e.kind).sort();
    assert.deepEqual(kinds, ["contains", "derived_from", "generated_from", "supported_by"]);
    for (const edge of Object.values(a.edges)) {
      assert.equal(edge.provenance, "foreign_key");
    }
  });

  it("乱序共享事件流 → 不同 hash（顺序敏感）", () => {
    const events = [
      sharedPublish(1, "source", "src-1", null),
      sharedPublish(2, "note", "note-1", { parentType: "source", parentEntityId: "src-1", fkName: "notes.source_id" }),
      sharedPublish(3, "card", "card-1", { parentType: "note", parentEntityId: "note-1", fkName: "note_versions.note_id" }),
    ];
    const a = replaySharedPlane(events);
    const b = replaySharedPlane([...events].reverse());
    assert.notEqual(a.hash, b.hash);
  });

  it("相同个人事件流重放得到相同投影与 hash；乱序不同", () => {
    const events = [validationEvent(1, "kp-1"), reviewEvent(2, "kp-1"), practiceTrail(3, "kp-1")];
    const a = replayPersonalPlane(events);
    const b = replayPersonalPlane(events.map((e) => ({ ...e })));
    assert.equal(a.hash, b.hash);
    assert.deepEqual(a, b);
    const reversed = replayPersonalPlane([...events].reverse());
    assert.notEqual(a.hash, reversed.hash);
  });
});

// ─── 两平面分离 ─────────────────────────────────────────────────────────────

describe("star-map-projections: 两平面分离", () => {
  it("共享平面只由 canonical Publish + FK 血缘驱动，个人平面只由个人事件驱动", () => {
    const sharedEvents = [
      sharedPublish(1, "source", "src-1", null),
      sharedPublish(2, "note", "note-1", { parentType: "source", parentEntityId: "src-1", fkName: "notes.source_id" }),
      sharedPublish(3, "card", "card-1", { parentType: "note", parentEntityId: "note-1", fkName: "note_versions.note_id" }),
      sharedPublish(4, "key_point", "kp-1", { parentType: "card", parentEntityId: "card-1", fkName: "learning_cards_v2.objective_id" }),
    ];
    const shared = replaySharedPlane(sharedEvents);

    const personalEvents = [validationEvent(1, "kp-1"), practiceTrail(2, "kp-1")];
    const personal = replayPersonalPlane(personalEvents);

    // 共享平面节点不含个人状态字段；个人平面不含共享血缘
    for (const node of Object.values(shared.nodes)) {
      assert.equal("durable" in node, false);
    }
    for (const key of Object.keys(personal.durability)) {
      assert.equal(shared.nodes[`key_point:${key}`]?.published, true);
    }
    const view = buildTwoPlaneView(shared, personal);
    assert.deepEqual(view.planes, { shared: "workspace_owned", personal: "user_private" });
    assert.ok(view.hash.length > 0);
  });

  it("共享平面 hash 不受个人事件影响，反之亦然", () => {
    const sharedEvents = [sharedPublish(1, "source", "src-1", null)];
    const s1 = replaySharedPlane(sharedEvents);
    const s2 = replaySharedPlane(sharedEvents);
    assert.equal(s1.hash, s2.hash);

    const p1 = replayPersonalPlane([validationEvent(1, "kp-1")]);
    const p2 = replayPersonalPlane([validationEvent(1, "kp-1"), practiceTrail(2, "kp-1")]);
    assert.notEqual(p1.hash, p2.hash);
    // 个人平面变化不影响共享平面
    assert.equal(s1.hash, replaySharedPlane(sharedEvents).hash);
  });
});

// ─── facet 可追合格 assessment ──────────────────────────────────────────────

describe("star-map-projections: facet 可追合格 assessment", () => {
  it("每条 facet 观测绑定 rubricItemId + 最近 assessment 事件 hash", () => {
    const events = [
      validationEvent(1, "kp-1"),
      validationEvent(2, "kp-1", "partial"),
    ];
    const plane = replayPersonalPlane(events);
    const facet = plane.facets["rubric-kp-1-explain"]!;
    assert.equal(facet.rubricItemId, "rubric-kp-1-explain");
    assert.equal(facet.keyPointId, "kp-1");
    assert.equal(facet.facet, "explain");
    assert.equal(facet.assessmentCount, 2);
    assert.equal(facet.lastVerdict, "covered");
    assert.ok(facet.lastAssessmentEventHash !== null);

    // 两个不同 outcome 的 validation 事件产生不同 hash，facet 应绑定最后一个（可追溯）
    const single = replayPersonalPlane([events[0]!]);
    const singleHash = single.facets["rubric-kp-1-explain"]!.lastAssessmentEventHash;
    const doubleHash = facet.lastAssessmentEventHash;
    assert.notEqual(singleHash, doubleHash);
  });

  it("非 validation 事件（practice/seen）不产生 facet 观测", () => {
    const plane = replayPersonalPlane([
      practiceTrail(1, "kp-1"),
      personalEvent(2, "understanding.event", { subjectType: "keyPoint", subjectId: "kp-1", action: "seen" }),
    ]);
    assert.equal(Object.keys(plane.facets).length, 0);
  });
});

// ─── 四透镜 ─────────────────────────────────────────────────────────────────

describe("star-map-projections: 四透镜", () => {
  const sharedEvents = [
    sharedPublish(1, "source", "src-1", null),
    sharedPublish(2, "note", "note-1", { parentType: "source", parentEntityId: "src-1", fkName: "notes.source_id" }),
    sharedPublish(3, "card", "card-1", { parentType: "note", parentEntityId: "note-1", fkName: "note_versions.note_id" }),
    sharedPublish(4, "key_point", "kp-1", { parentType: "card", parentEntityId: "card-1", fkName: "learning_cards_v2.objective_id" }),
    sharedPublish(5, "key_point", "kp-2", { parentType: "card", parentEntityId: "card-1", fkName: "learning_cards_v2.objective_id" }),
    sharedPublish(6, "evidence", "ev-1", { parentType: "key_point", parentEntityId: "kp-1", fkName: "evidences.key_point_id" }),
  ];
  const shared = replaySharedPlane(sharedEvents);
  const personal = replayPersonalPlane([validationEvent(1, "kp-1")]);

  it("关系透镜只展示确定性血缘；relation hints 不画成共享语义边", () => {
    const lenses = buildFourLensViews({
      shared,
      personal,
      currentTargetKeyPointId: "kp-1",
      currentTargetCardId: "card-1",
      suggestedRoute: null,
      evidences: [],
      questionLensEnabled: false,
      relationGovernanceEnabled: false,
      dashedCandidates: [
        { candidateId: "cand-1", from: "key_point:kp-1", to: "note:note-1", kind: "causal" },
      ],
    });
    const relation = lenses.relation;
    assert.equal(relation.sharedSemanticEdgesHidden, true);
    assert.equal(relation.lineageEdges.length, Object.keys(shared.edges).length);
    // Should flag 关闭：虚线 candidate 一律不可见（动作不可见）
    assert.deepEqual(relation.dashedCandidates, []);
    // 没有任何非 FK provenance 边
    assert.ok(relation.lineageEdges.every((e) => e.provenance === "foreign_key"));
  });

  it("Should flag 开启时虚线 candidate 可见（但仍不进入 formal target）", () => {
    const lenses = buildFourLensViews({
      shared,
      personal,
      currentTargetKeyPointId: "kp-1",
      currentTargetCardId: "card-1",
      suggestedRoute: null,
      evidences: [],
      questionLensEnabled: true,
      relationGovernanceEnabled: true,
      dashedCandidates: [
        { candidateId: "cand-1", from: "key_point:kp-1", to: "note:note-1", kind: "causal" },
      ],
    });
    assert.deepEqual(lenses.relation.dashedCandidates, [
      { candidateId: "cand-1", from: "key_point:kp-1", to: "note:note-1", kind: "causal" },
    ]);
    assert.equal(lenses.question.enabled, true);
    assert.equal(lenses.question.markers.length, 0);
  });

  it("当前目标透镜：Key Point + 建议路线 + 同 Card sibling", () => {
    const lenses = buildFourLensViews({
      shared,
      personal,
      currentTargetKeyPointId: "kp-1",
      currentTargetCardId: "card-1",
      suggestedRoute: {
        keyPointId: "kp-1",
        prioritySource: "official_scheduler",
        nextReviewAt: "2026-08-15T02:00:00.000Z",
        routeEligible: true,
        routeReasonCode: "eligible_silent_mastery_route",
      },
      evidences: [],
      questionLensEnabled: false,
      relationGovernanceEnabled: false,
      dashedCandidates: [],
    });
    const target = lenses.currentTarget!;
    assert.equal(target.keyPointId, "kp-1");
    assert.equal(target.cardId, "card-1");
    assert.deepEqual(target.siblingKeyPointIds, ["kp-2"]);
    assert.equal(target.suggestedRoute?.prioritySource, "official_scheduler");
    assert.equal(target.suggestedRoute?.routeEligible, true);
  });

  it("证据透镜：来源/exact evidence/semantic support/版本", () => {
    const lenses = buildFourLensViews({
      shared,
      personal,
      currentTargetKeyPointId: "kp-1",
      currentTargetCardId: "card-1",
      suggestedRoute: null,
      evidences: [
        {
          evidenceId: "ev-1",
          keyPointId: "kp-1",
          sourceId: "src-1",
          noteId: "note-1",
          exactQuoteHash: "h-exact",
          exactQuote: true,
          semanticSupportReportId: "ssr-1",
          semanticSupportReportHash: "h-ssr",
          version: "v1",
        },
      ],
      questionLensEnabled: false,
      relationGovernanceEnabled: false,
      dashedCandidates: [],
    });
    assert.equal(lenses.evidence.keyPointId, "kp-1");
    assert.equal(lenses.evidence.evidences.length, 1);
    assert.equal(lenses.evidence.evidences[0]!.semanticSupportReportHash, "h-ssr");
    assert.equal(lenses.evidence.evidences[0]!.exactQuote, true);
  });
});

// ─── 节点详情（不各自成透镜）────────────────────────────────────────────────

describe("star-map-projections: 节点详情", () => {
  it("到期/能力切面/最近验证/assistance cooldown 放节点详情", () => {
    const personal = replayPersonalPlane([
      validationEvent(1, "kp-1"),
      personalEvent(2, "assistance.recorded", {
        keyPointId: "kp-1",
        assistanceLevel: "content_assisted",
        occurredAt: "2026-08-08T01:30:00.000Z",
        cooldownUntil: "2026-08-08T02:30:00.000Z",
      }),
    ]);
    const detail = buildNodeDetail({
      nodeType: "key_point",
      entityId: "kp-1",
      personal,
      dueReview: { due: true, nextReviewAt: "2026-08-08T02:00:00.000Z" },
      exposure: { viewedCount: 3, lastViewedAt: "2026-08-08T01:10:00.000Z" },
    });
    assert.equal(detail.dueReview?.due, true);
    assert.equal(detail.facets.length, 1);
    assert.equal(detail.facets[0]!.rubricItemId, "rubric-kp-1-explain");
    assert.equal(detail.recentValidation?.outcome, "pass");
    assert.equal(detail.assistance?.assistanceCount, 1);
    assert.equal(detail.assistance?.cooldownUntil, "2026-08-08T02:30:00.000Z");
    // 只读 exposure 不点亮理解
    assert.equal(detail.exposure?.viewedCount, 3);
    assert.equal(detail.recentValidation?.at, "2026-08-08T01:00:00.000Z");
  });
});

// ─── LOD（§10.6）────────────────────────────────────────────────────────────

describe("star-map-projections: 低缩放 LOD 保留规则", () => {
  it("按当前目标/priority/gap/重要性保留，不随机取样", () => {
    const shared = replaySharedPlane([
      sharedPublish(1, "card", "card-1", null, { officialPriority: 0.2 }),
      sharedPublish(2, "card", "card-2", null, { officialPriority: 0.8 }),
      sharedPublish(3, "card", "card-3", null, { officialPriority: 0.1 }),
      sharedPublish(4, "card", "card-target", null),
    ]);
    const result = selectLodNodes({
      currentTargetKeyPointId: "kp-target",
      targetEntityIds: new Set(["card-target"]),
      nodes: Object.values(shared.nodes),
      officialPriority: () => 0,
      canonicalGap: (entityId) => entityId === "card-3",
      importance: () => 0,
      targetNodeCount: 3,
    });
    assert.equal(result.selected.length, 3);
    // 当前目标锚定 card-target 一定保留
    assert.ok(result.selected.includes("card:card-target"));
    // 高 priority 的 card-2 一定保留
    assert.ok(result.selected.includes("card:card-2"));
    // 有 canonical gap 的 card-3 一定保留
    assert.ok(result.selected.includes("card:card-3"));
    // 分数排序：card-target > card-2 > card-3 > card-1
    const scores = new Map(result.scores.map((s) => [s.nodeId, s.score]));
    assert.ok(scores.get("card:card-target")! > scores.get("card:card-2")!);
    assert.ok(scores.get("card:card-2")! > scores.get("card:card-3")!);
    assert.ok(scores.get("card:card-3")! > scores.get("card:card-1")!);
  });

  it("确定性：相同输入 → 相同选择结果", () => {
    const shared = replaySharedPlane([
      sharedPublish(1, "card", "card-1", null, { officialPriority: 0.5 }),
      sharedPublish(2, "card", "card-2", null, { officialPriority: 0.4 }),
    ]);
    const input = {
      currentTargetKeyPointId: null,
      targetEntityIds: new Set<string>(),
      nodes: Object.values(shared.nodes),
      officialPriority: () => 0,
      canonicalGap: () => false,
      importance: () => 0,
      targetNodeCount: 2,
    };
    const a = selectLodNodes(input);
    const b = selectLodNodes(input);
    assert.deepEqual(a.selected, b.selected);
  });
});

// ─── 行动入口与 Scene 连线边界（§10.3）─────────────────────────────────────

describe("star-map-projections: 行动入口与 Scene 连线边界", () => {
  it("选中 Card/Key Point 可开始/继续航程、朗读、查看证据、Tutor、返回来源", () => {
    const cardActions = planNodeActions({
      nodeType: "card",
      questionLensEnabled: false,
      relationGovernanceEnabled: false,
    }).actions;
    assert.ok(cardActions.includes("start_or_continue_journey"));
    assert.ok(cardActions.includes("read_aloud"));
    assert.ok(cardActions.includes("view_evidence"));
    assert.ok(cardActions.includes("back_to_source"));
    assert.ok(!cardActions.includes("invoke_current_target_tutor"));

    const kpActions = planNodeActions({
      nodeType: "key_point",
      questionLensEnabled: false,
      relationGovernanceEnabled: false,
    }).actions;
    assert.ok(kpActions.includes("invoke_current_target_tutor"));

    // Should flag 关闭：问题标记与关系提议不可见
    assert.ok(!kpActions.includes("mark_question"));
    assert.ok(!kpActions.includes("propose_relation"));

    // Should flag 开启：动作可见（但仍只是 candidate/标记）
    const enabled = planNodeActions({
      nodeType: "key_point",
      questionLensEnabled: true,
      relationGovernanceEnabled: true,
    }).actions;
    assert.ok(enabled.includes("mark_question"));
    assert.ok(enabled.includes("propose_relation"));
    assert.equal(
      planNodeActions({ nodeType: "key_point", questionLensEnabled: false, relationGovernanceEnabled: false })
        .relationUnderstandingClaimed,
      false,
    );
  });

  it("Scene 连线只是 Episode Response Artifact，不会自动创建共享边", () => {
    const verdict = assertSceneConnectionDoesNotPublishEdge({
      sceneConnection: { from: "kp-1", to: "kp-2" },
      autoPublishSharedEdge: false,
    });
    assert.equal(verdict.autoPublishSharedEdge, false);
    assert.equal(verdict.disposal, "candidate_proposal_only");

    // 试图自动发布共享边 → fail closed 抛错
    assert.throws(() =>
      assertSceneConnectionDoesNotPublishEdge({
        sceneConnection: { from: "kp-1", to: "kp-2" },
        autoPublishSharedEdge: true,
      }),
    );
  });
});
