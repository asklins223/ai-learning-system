/**
 * 任务 14 接线：buildJourneyPlan 纯函数单测（14 方案 §3.1/§3.6 + 03-2 PREPARE）。
 *
 * 锁定服务端编排语义（前端直接消费，不再 fail-closed）：
 * - structured_mastery_bundle + eligible + Gold → silent 正式航程
 *   （≥2 互补 Scene，按 family 选择默认序列）；
 * - voice_mastery → voice；
 * - transfer gate（rubricComplete+evidenceComplete）→ transfer record_only；
 * - facet_only → facet-only（text，trustCeiling=facet_eligible）；
 * - 其余 → practice（text 兜底，不无路可走）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildJourneyPlan } from "./journey-plan.ts";

const base = {
  formalPlanKind: "structured_mastery_bundle",
  authorizedAction: "create_initial" as const,
  rubricComplete: false,
  evidenceComplete: false,
  structuredProofEligibility: "eligible" as const,
  crossModalGoldPassed: true,
  keyPointId: "kp-1",
  silentSceneData: {
    ordering: {
      items: [
        { id: "step-1-a", text: "第一步" },
        { id: "step-2-b", text: "第二步" },
        { id: "step-3-c", text: "第三步" },
      ],
      shuffleStrategy: "deterministic-fragment-order",
      emptySlots: 3,
      dragProtocol: "tap-select-place",
    },
    repair: {
      brokenTokens: [{ id: "t1", text: "第二步" }],
      operationProtocol: "tap-select-place",
      allowedOperations: ["delete", "replace", "move"],
    },
  },
};

describe("buildJourneyPlan：silent 正式航程（§7 决策 2）", () => {
  it("structured_mastery_bundle + eligible + Gold + sceneData → silent，scenes 携带真实 keyPointId", () => {
    const plan = buildJourneyPlan(base);
    assert.equal(plan.mode, "silent");
    assert.deepEqual(plan.scenePlan, ["ordering", "repair"]);
    assert.equal(plan.trustCeiling, "mastery_eligible");
    assert.equal(plan.reason, "silent-formal-plan");
    assert.equal(plan.scenes?.length, 2);
    assert.equal(plan.scenes?.[0].targetKeyPointId, "kp-1");
    assert.equal(plan.scenes?.[0].sceneType, "ordering");
  });

  it("eligible + Gold 但无 sceneData（claim 不足）→ 不展示 silent（fail-closed 回退，§3.7）", () => {
    const plan = buildJourneyPlan({ ...base, silentSceneData: null });
    assert.notEqual(plan.mode, "silent");
  });

  it("causal_boundary family（确定性 Author 未支持）→ 不展示 silent（不把 scenePlan 伪装成可渲染）", () => {
    const plan = buildJourneyPlan({ ...base, silentProfileFamily: "causal_boundary" });
    assert.notEqual(plan.mode, "silent");
  });

  it("eligible 但未过 Gold → 不展示 silent（fail closed，服务端硬门槛）", () => {
    const plan = buildJourneyPlan({ ...base, crossModalGoldPassed: false });
    assert.notEqual(plan.mode, "silent");
  });

  it("not_eligible → 不展示 silent", () => {
    const plan = buildJourneyPlan({ ...base, structuredProofEligibility: "not_eligible" });
    assert.notEqual(plan.mode, "silent");
  });
});

describe("buildJourneyPlan：voice 与 transfer", () => {
  it("voice_mastery → voice（voice_teachback）", () => {
    const plan = buildJourneyPlan({
      ...base,
      formalPlanKind: "voice_mastery",
      structuredProofEligibility: "not_eligible",
    });
    assert.equal(plan.mode, "voice");
    assert.deepEqual(plan.scenePlan, ["voice_teachback"]);
    assert.equal(plan.trustCeiling, "mastery_eligible");
  });

  it("transfer gate 双要件齐全 → transfer（record_only，0 schedule 副作用）", () => {
    const plan = buildJourneyPlan({
      ...base,
      formalPlanKind: "voice_mastery",
      structuredProofEligibility: "not_eligible",
      rubricComplete: true,
      evidenceComplete: true,
    });
    assert.equal(plan.mode, "transfer");
    assert.equal(plan.trustCeiling, "record_only");
    assert.equal(plan.reason, "transfer-gate-passed");
  });

  it("rubric/evidence 任一不全 → transfer 不可用（fail closed）", () => {
    const plan = buildJourneyPlan({
      ...base,
      formalPlanKind: "voice_mastery",
      structuredProofEligibility: "not_eligible",
      rubricComplete: true,
      evidenceComplete: false,
    });
    assert.notEqual(plan.mode, "transfer");
  });
});

describe("buildJourneyPlan：facet-only 与 practice 兜底", () => {
  it("facet_only → text，trustCeiling=facet_eligible（复习时间不变明示）", () => {
    const plan = buildJourneyPlan({
      ...base,
      formalPlanKind: "facet_only",
      structuredProofEligibility: "not_eligible",
      authorizedAction: "record_only",
    });
    assert.equal(plan.mode, "text");
    assert.equal(plan.trustCeiling, "facet_eligible");
    assert.equal(plan.reason, "facet-only");
  });

  it("其余 → practice（text 兜底，绝无无路可走）", () => {
    const plan = buildJourneyPlan({
      ...base,
      formalPlanKind: "practice",
      structuredProofEligibility: "not_eligible",
      authorizedAction: "no_effect",
    });
    assert.equal(plan.mode, "practice");
    assert.equal(plan.trustCeiling, "practice");
  });
});
