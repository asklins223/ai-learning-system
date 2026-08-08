/**
 * 任务 05-2：Scene Activation Service 单测。
 *
 * 覆盖（验收，05-w4 任务 05-2 / 01-2 §3.3）：
 * - 唯一激活权限：Author/Supervisor/Critic/Companion 均无 activate 权限；
 * - 事务内验证顺序：staging → safety approved → critic/static → 两态一致 →
 *   hashes → planHash → epoch → BudgetEnvelope → 写入一次 immutable contract；
 * - 两态 formal（无即时泄题）/ practice（可即时反馈，ceiling=practice_only）；
 * - exactly-once：同冻结输入 nonce 恒等，二次写入被拒绝。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CapabilityFacet, TrustClass } from "@ailearn/shared";
import {
  activateSceneContract,
  ACTIVATION_AUTHORIZED_ACTOR,
  assertNoActivatePermission,
  checkModeConsistency,
  computeActivationNonce,
  isActivationAuthorizedActor,
  NO_ACTIVATE_ACTOR_IDS,
  SceneActivationError,
  type ActiveSceneContract,
  type ActivationPorts,
  type SceneActivationInput,
} from "./scene-activation.ts";
import {
  computeDisclosureProfileHash,
  computePublicPayloadHash,
  computeSecretSolutionHash,
  SceneMode,
  SceneSafetyVerdict,
  type LearningScene,
  type OrderingScene,
  type PrivateEpisodeContractLite,
  type SceneSafetyReport,
} from "./scene-safety.ts";

// ─── Fixtures / helpers ───────────────────────────────────────────────────

function fillHashes<S extends LearningScene>(scene: S): S {
  return {
    ...scene,
    publicPayloadHash: computePublicPayloadHash(scene),
    secretSolutionHash: computeSecretSolutionHash(scene),
  };
}

function orderingScene(overrides?: Partial<OrderingScene>): OrderingScene {
  const scene: OrderingScene = {
    sceneId: "sc-ord-1",
    sceneType: "ordering",
    template: "ordering-scene-v1",
    version: "v1",
    target: { keyPointId: "kp-1", targetIds: ["kp-1"] },
    sourceFingerprint: "fp-a",
    capabilityFacet: CapabilityFacet.PROCEDURE,
    mode: SceneMode.FORMAL,
    publicPayloadHash: "",
    publicPayloadVersion: "v1",
    secretSolutionHash: "",
    secretSolutionVersion: "v1",
    disclosureProfile: {
      maxProvableTrustClass: TrustClass.FACET_ELIGIBLE,
      exposesTokenText: true,
      provableRecall: false,
      feedbackTiming: "after_all_probes",
    },
    rubricEvidenceBindings: [
      {
        rubricItemId: "ri-1",
        criterion: "重建正确步骤顺序",
        evidenceRefIds: ["ev-1"],
        evidenceKind: "ordering_reconstruction",
        expectedTargetHash: "e".repeat(64),
      },
    ],
    assistancePolicy: {
      contentHelpAllowed: false,
      maxContentHelpCount: 0,
      revealsAnswerOnAttempt: false,
      neutralAssistanceOnly: true,
    },
    templateTrustCeiling: TrustClass.FACET_ELIGIBLE,
    feedbackTiming: "after_all_probes",
    distractorIds: ["item-3"],
    branchIds: [],
    maxOperations: 6,
    maxAttempts: 2,
    a11yEquivalentPaths: [
      { kind: "tap_select_place", description: "点选-放置", semanticRequirementUnchanged: true },
      { kind: "keyboard", description: "键盘移动", semanticRequirementUnchanged: true },
      { kind: "screen_reader", description: "读屏顺序描述", semanticRequirementUnchanged: true },
      { kind: "reduced_motion", description: "静态变化", semanticRequirementUnchanged: true },
    ],
    public: {
      items: [
        { id: "item-1", text: "第一步：收集证据" },
        { id: "item-2", text: "第二步：形成假设" },
        { id: "item-3", text: "错误项：先下结论" },
      ],
      shuffleStrategy: "full",
      emptySlots: 0,
      dragProtocol: "drag 或 tap-select-place",
    },
    secret: {
      correctOrderIds: ["item-1", "item-2"],
      distractorItemIds: ["item-3"],
      acceptPermutedGroups: [],
      rationaleRefs: [],
    },
  };
  return fillHashes({ ...scene, ...overrides });
}

function approvedReport(scene: LearningScene): SceneSafetyReport {
  return {
    reportId: `safety:${scene.sceneId}`,
    sceneId: scene.sceneId,
    mode: scene.mode,
    verdict: SceneSafetyVerdict.APPROVED,
    checks: [],
    criticApproved: true,
    staticCertificationUsed: false,
    repairAttempts: 0,
    reasonCodes: [],
    reportHash: "r".repeat(64),
  };
}

function episodeFixture(
  scene: LearningScene,
  report: SceneSafetyReport,
  overrides?: Partial<PrivateEpisodeContractLite>,
): PrivateEpisodeContractLite {
  return {
    episodeId: "ep-1",
    keyPointId: "kp-1",
    formalEligibilityKind: "initial_validation",
    formalPlan: { kind: "structured_mastery_bundle", requiredProbeIds: ["probe-1"] },
    schedulingDecision: { authorizedAction: "create_initial" },
    frozenProbes: [
      {
        probeId: "probe-1",
        publicSceneContractId: "psc-1",
        publicPayloadHash: scene.publicPayloadHash,
        privateSolutionId: "sol-1",
        privateSolutionHash: scene.secretSolutionHash,
        sceneSafetyReportId: report.reportId,
        sceneSafetyReportHash: report.reportHash,
        templateTrustCeiling: scene.templateTrustCeiling,
        disclosureProfileHash: computeDisclosureProfileHash(scene),
      },
    ],
    episodeTargetFingerprint: "fp",
    contentExposureKey: "cek",
    rubricTargets: [{ id: "ri-1", capabilityFacet: CapabilityFacet.PROCEDURE }],
    allowedModalities: ["ordering"],
    runtimeEpochSnapshot: 0,
    episodeEpoch: 1,
    budgetEnvelopeRef: "env:x",
    budgetEnvelopeHash: "envh",
    planHash: "plan:abc",
    ...overrides,
  };
}

function ports(overrides?: Partial<ActivationPorts>): ActivationPorts {
  return {
    readStagingStatus: () => ({ status: "staged" }),
    verifyPlanHash: () => true,
    writeActiveContract: () => ({ ok: true }),
    ...overrides,
  };
}

function activationInput(
  overrides?: Partial<SceneActivationInput>,
): SceneActivationInput {
  const scene = orderingScene();
  const report = approvedReport(scene);
  return {
    actor: ACTIVATION_AUTHORIZED_ACTOR,
    scene,
    probe: { probeId: "probe-1", publicSceneContractId: "psc-1", privateSolutionId: "sol-1" },
    safetyReport: report,
    episode: episodeFixture(scene, report),
    currentEpoch: { runtimeEpoch: 0, episodeEpoch: 1 },
    budgetEnvelope: { envelopeRef: "env:x", envelopeHash: "envh", sufficient: true },
    ...overrides,
  };
}

// ─── 权限（Author/Supervisor/Critic/Companion 无 activate 权限）──────────

describe("activate_scene_contract 权限", () => {
  it("scene_activation 是唯一授权 actor", () => {
    assert.equal(isActivationAuthorizedActor("scene_activation"), true);
    for (const actor of NO_ACTIVATE_ACTOR_IDS) {
      assert.equal(isActivationAuthorizedActor(actor), false, `actor ${actor} must not activate`);
    }
  });

  it("越权 actor 激活 → no_activate_permission", () => {
    const input = activationInput({ actor: "scene_author" });
    const verdict = activateSceneContract(input, ports());
    assert.equal(verdict.ok, false);
    if (!verdict.ok) assert.equal(verdict.errorCode, "no_activate_permission");
  });

  it("assertNoActivatePermission 对 Author/Critic/Companion 抛错", () => {
    for (const actor of [
      "scene_author",
      "session_supervisor",
      "rubric_scene_critic",
      "assessment_critic",
      "grounded_tutor",
      "grounded_answer_critic",
      "companion",
    ] as const) {
      assert.throws(() => assertNoActivatePermission(actor), SceneActivationError);
    }
  });
});

// ─── 两态 formal / practice ──────────────────────────────────────────────

describe("两态（formal / practice）", () => {
  it("formal 无即时泄题 → 通过；immediate 反馈 → formal_practice_mismatch", () => {
    assert.equal(checkModeConsistency(orderingScene()).ok, true);

    const formalImmediate = orderingScene({ feedbackTiming: "immediate" });
    assert.equal(checkModeConsistency(formalImmediate).ok, false);

    const verdict = activateSceneContract(
      activationInput({
        scene: formalImmediate,
        safetyReport: { ...approvedReport(formalImmediate), checks: [], reasonCodes: [] },
      }),
      ports(),
    );
    assert.equal(verdict.ok, false);
    if (!verdict.ok) assert.equal(verdict.errorCode, "formal_practice_mismatch");
  });

  it("practice 模式 ceiling 必须为 practice_only；可即时反馈", () => {
    const practice = orderingScene({
      mode: SceneMode.PRACTICE,
      templateTrustCeiling: TrustClass.PRACTICE_ONLY,
      feedbackTiming: "immediate",
      disclosureProfile: {
        maxProvableTrustClass: TrustClass.PRACTICE_ONLY,
        exposesTokenText: true,
        provableRecall: false,
        feedbackTiming: "immediate",
      },
    });
    assert.equal(checkModeConsistency(practice).ok, true);

    const highCeiling = orderingScene({
      mode: SceneMode.PRACTICE,
      templateTrustCeiling: TrustClass.MASTERY_ELIGIBLE,
      feedbackTiming: "immediate",
    });
    assert.equal(checkModeConsistency(highCeiling).ok, false);
  });
});

// ─── 事务内验证顺序 ──────────────────────────────────────────────────────

describe("validateSceneActivation 事务校验", () => {
  it("staging 非 staged → scene_not_staged", () => {
    const verdict = activateSceneContract(
      activationInput(),
      ports({ readStagingStatus: () => ({ status: "missing" }) }),
    );
    assert.equal(verdict.ok, false);
    if (!verdict.ok) assert.equal(verdict.errorCode, "scene_not_staged");
  });

  it("safety 非 approved → scene_safety_not_approved", () => {
    const scene = orderingScene();
    const report: SceneSafetyReport = {
      ...approvedReport(scene),
      verdict: SceneSafetyVerdict.BLOCKED,
    };
    const verdict = activateSceneContract(activationInput({ safetyReport: report }), ports());
    assert.equal(verdict.ok, false);
    if (!verdict.ok) assert.equal(verdict.errorCode, "scene_safety_not_approved");
  });

  it("approved 但 Critic 未批且非静态认证 → critic_not_approved", () => {
    const scene = orderingScene();
    const report: SceneSafetyReport = {
      ...approvedReport(scene),
      criticApproved: false,
      staticCertificationUsed: false,
    };
    const verdict = activateSceneContract(activationInput({ safetyReport: report }), ports());
    assert.equal(verdict.ok, false);
    if (!verdict.ok) assert.equal(verdict.errorCode, "critic_not_approved");
  });

  it("frozen probe hashes 与 scene/report 逐项失配 → hash_mismatch", () => {
    const scene = orderingScene();
    const report = approvedReport(scene);
    const episode = episodeFixture(scene, report, {
      frozenProbes: [
        {
          probeId: "probe-1",
          publicSceneContractId: "psc-1",
          publicPayloadHash: "0".repeat(64), // 与 scene.publicPayloadHash 不一致
          privateSolutionId: "sol-1",
          privateSolutionHash: scene.secretSolutionHash,
          sceneSafetyReportId: report.reportId,
          sceneSafetyReportHash: report.reportHash,
          templateTrustCeiling: scene.templateTrustCeiling,
          disclosureProfileHash: computeDisclosureProfileHash(scene),
        },
      ],
    });
    const verdict = activateSceneContract(activationInput({ episode }), ports());
    assert.equal(verdict.ok, false);
    if (!verdict.ok) assert.equal(verdict.errorCode, "hash_mismatch");
  });

  it("probe 不在冻结集合 → hash_mismatch", () => {
    const scene = orderingScene();
    const report = approvedReport(scene);
    const episode = episodeFixture(scene, report, {
      frozenProbes: [{ ...episodeFixture(scene, report).frozenProbes[0], probeId: "other-probe" }],
    });
    const verdict = activateSceneContract(
      activationInput({ episode }),
      ports(),
    );
    assert.equal(verdict.ok, false);
    if (!verdict.ok) assert.equal(verdict.errorCode, "hash_mismatch");
  });

  it("planHash 未覆盖 probe → plan_hash_mismatch", () => {
    const verdict = activateSceneContract(
      activationInput(),
      ports({ verifyPlanHash: () => false }),
    );
    assert.equal(verdict.ok, false);
    if (!verdict.ok) assert.equal(verdict.errorCode, "plan_hash_mismatch");
  });

  it("epoch 失配 / 缺失 → epoch_mismatch（fail closed）", () => {
    const stale = activateSceneContract(
      activationInput({ currentEpoch: { runtimeEpoch: 5, episodeEpoch: 1 } }),
      ports(),
    );
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.errorCode, "epoch_mismatch");

    const missing = activateSceneContract(
      activationInput({ currentEpoch: { runtimeEpoch: null, episodeEpoch: 1 } }),
      ports(),
    );
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.errorCode, "epoch_mismatch");
  });

  it("BudgetEnvelope 失配或不足 → budget_insufficient", () => {
    const insufficient = activateSceneContract(
      activationInput({ budgetEnvelope: { envelopeRef: "env:x", envelopeHash: "envh", sufficient: false } }),
      ports(),
    );
    assert.equal(insufficient.ok, false);
    if (!insufficient.ok) assert.equal(insufficient.errorCode, "budget_insufficient");

    const refMismatch = activateSceneContract(
      activationInput({ budgetEnvelope: { envelopeRef: "env:other", envelopeHash: "envh", sufficient: true } }),
      ports(),
    );
    assert.equal(refMismatch.ok, false);
    if (!refMismatch.ok) assert.equal(refMismatch.errorCode, "budget_insufficient");
  });
});

// ─── 成功路径与 exactly-once ─────────────────────────────────────────────

describe("activateSceneContract 成功路径", () => {
  it("全部校验通过 → ok，产出 immutable active contract（零 private 字段）", () => {
    let writeCount = 0;
    const verdict = activateSceneContract(
      activationInput(),
      ports({
        writeActiveContract: (contract) => {
          writeCount += 1;
          assert.equal(contract.immutable, true);
          return { ok: true };
        },
      }),
    );
    assert.equal(verdict.ok, true);
    assert.equal(writeCount, 1);
    if (verdict.ok) {
      const contract: ActiveSceneContract = verdict.activeContract;
      assert.equal(contract.contractVersion, "active-scene-contract-v1");
      assert.equal(contract.mode, SceneMode.FORMAL);
      assert.equal(contract.hashes.publicPayloadHash, contract.publicSceneContract.publicPayloadHash);
      assert.equal(contract.hashes.planHash, "plan:abc");
      assert.deepEqual(contract.epochSnapshot, { runtimeEpoch: 0, episodeEpoch: 1 });
      // 净化 publicSceneContract：零 private 字段（序列化不含 secret 字段名）。
      const serialized = JSON.stringify(contract.publicSceneContract);
      for (const forbidden of ["correctOrderIds", "distractorItemIds", "secret", "expectedTargetHash", "rubricTargets"]) {
        assert.equal(serialized.includes(forbidden), false, `private field ${forbidden} must not leak`);
      }
    }
  });

  it("activation nonce 确定性：同冻结输入恒等；不同输入不同", () => {
    const base = { sceneId: "sc-1", probeId: "probe-1", planHash: "plan:a", publicPayloadHash: "a".repeat(64), privateSolutionHash: "b".repeat(64), runtimeEpoch: 0, episodeEpoch: 1 };
    assert.equal(computeActivationNonce(base), computeActivationNonce({ ...base }));
    assert.notEqual(computeActivationNonce(base), computeActivationNonce({ ...base, episodeEpoch: 2 }));
  });

  it("exactly-once：二次写入被拒绝 → already_active", () => {
    const written = new Set<string>();
    const p = ports({
      writeActiveContract: (contract) => {
        if (written.has(contract.activationNonce)) return { ok: false, code: "already_active" as const };
        written.add(contract.activationNonce);
        return { ok: true };
      },
    });
    const first = activateSceneContract(activationInput(), p);
    assert.equal(first.ok, true);
    const second = activateSceneContract(activationInput(), p);
    assert.equal(second.ok, false);
    if (!second.ok) assert.equal(second.errorCode, "already_active");
  });
});
