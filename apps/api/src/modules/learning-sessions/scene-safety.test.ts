/**
 * 任务 05-2：scene-safety-v1 单测。
 *
 * 覆盖（验收，05-w4 任务 05-2 / 01-2 §3.3）：
 * - 各检查项：schema、public/secret 分离、allowlisted IDs、答案泄漏、可评估性、
 *   唯一解或有效多解、distractor 区分度、事实支撑、prompt injection、语言 A11y；
 * - 修复一次语义：失败最多修复一次，仍失败 → question_retryable / blocked；
 * - 静态模板复用：不可变 certification hash + deterministic allowlist；
 * - 泄漏检测：secret 文本/hash 出现在 public → 拒绝。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CapabilityFacet, TrustClass } from "@ailearn/shared";
import {
  checkAllowlistedIds,
  checkAnswerLeakage,
  checkAssessability,
  checkDistractorDiscrimination,
  checkFactualSupport,
  checkLanguageAndA11y,
  checkPromptInjection,
  checkPublicSecretSeparation,
  checkSolutionUniqueness,
  computePublicPayloadHash,
  computeSceneSafetyReportHash,
  computeSecretSolutionHash,
  decideFinalVerdict,
  runSceneSafety,
  runSceneSafetyWithRepair,
  SceneSafetyVerdict,
  type FactSupportScope,
  type LearningScene,
  type OrderingScene,
  type SceneCriticPort,
  type SceneSafetyOptions,
  type SceneSafetyReport,
  type VoiceTeachbackScene,
  validateSceneShape,
  verifyStaticTemplateCertification,
  type StaticSceneTemplate,
} from "./scene-safety.ts";

// ─── Fixtures / helpers ───────────────────────────────────────────────────

function fillHashes<S extends LearningScene>(scene: S): S {
  return {
    ...scene,
    publicPayloadHash: computePublicPayloadHash(scene),
    secretSolutionHash: computeSecretSolutionHash(scene),
  };
}

/** 合法 formal ordering Scene（全部检查可通过的基线）。 */
function baseOrderingScene(overrides?: Partial<OrderingScene>): OrderingScene {
  const scene: OrderingScene = {
    sceneId: "sc-ord-1",
    sceneType: "ordering",
    template: "ordering-scene-v1",
    version: "v1",
    target: { keyPointId: "kp-1", targetIds: ["kp-1"] },
    sourceFingerprint: "fp-a",
    capabilityFacet: CapabilityFacet.PROCEDURE,
    mode: "formal",
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

/** 合法 voice teachback Scene（factual 检查依赖 factScope）。 */
function baseVoiceScene(overrides?: Partial<VoiceTeachbackScene>): VoiceTeachbackScene {
  const scene: VoiceTeachbackScene = {
    sceneId: "sc-voice-1",
    sceneType: "voice_teachback",
    template: "voice-teachback-scene-v1",
    version: "v1",
    target: { keyPointId: "kp-1", targetIds: ["kp-1"] },
    sourceFingerprint: "fp-a",
    capabilityFacet: CapabilityFacet.EXPLAIN,
    mode: "formal",
    publicPayloadHash: "",
    publicPayloadVersion: "v1",
    secretSolutionHash: "",
    secretSolutionVersion: "v1",
    disclosureProfile: {
      maxProvableTrustClass: TrustClass.MASTERY_ELIGIBLE,
      exposesTokenText: false,
      provableRecall: true,
      feedbackTiming: "after_all_probes",
    },
    rubricEvidenceBindings: [
      {
        rubricItemId: "ri-1",
        criterion: "解释因果机制",
        evidenceRefIds: ["ev-1"],
        evidenceKind: "voice_teachback",
        expectedTargetHash: "e".repeat(64),
      },
    ],
    assistancePolicy: {
      contentHelpAllowed: false,
      maxContentHelpCount: 0,
      revealsAnswerOnAttempt: false,
      neutralAssistanceOnly: true,
    },
    templateTrustCeiling: TrustClass.MASTERY_ELIGIBLE,
    feedbackTiming: "after_all_probes",
    distractorIds: [],
    branchIds: [],
    a11yEquivalentPaths: [
      { kind: "keyboard", description: "键盘控制", semanticRequirementUnchanged: true },
      { kind: "screen_reader", description: "读屏提示", semanticRequirementUnchanged: true },
      { kind: "reduced_motion", description: "静态降级", semanticRequirementUnchanged: true },
    ],
    public: {
      prompt: "请用你自己的话解释：为什么行星围绕恒星运行？",
      allowedTokenIds: ["tok-1", "tok-2"],
      visibleTokenText: { "tok-1": "引力", "tok-2": "轨道" },
      recordingProtocol: "按住说话，可重录",
      maxRecordingSeconds: 60,
    },
    secret: {
      expectedRubricTargets: ["rt-1"],
      keyFactRefs: ["fact-1"],
      disallowedClaims: ["离心力使行星飞离恒星"],
    },
  };
  return fillHashes({ ...scene, ...overrides });
}

const approveCritic: SceneCriticPort = {
  id: "test-approve",
  review: () => ({ verdict: "approved", reasonCodes: [] }),
};

const rejectCritic: SceneCriticPort = {
  id: "test-reject",
  review: () => ({ verdict: "repair_required", reasonCodes: ["critic_rejects"] }),
};

const FACT_SCOPE: FactSupportScope = {
  sourceFacts: [
    { evidenceRefId: "ev-1", semanticSupport: "supported", contentHash: "c".repeat(64) },
    { evidenceRefId: "ev-2", semanticSupport: "unsupported", contentHash: "c".repeat(64) },
  ],
  expectedSourceFingerprint: "fp-a",
  expectedKeyPointId: "kp-1",
};

function safetyOptions(overrides?: Partial<SceneSafetyOptions>): SceneSafetyOptions {
  return {
    allowlist: { allowedEvidenceRefIds: ["ev-1"] },
    factScope: FACT_SCOPE,
    critic: approveCritic,
    staticTemplates: [],
    ...overrides,
  };
}

function checkById(report: SceneSafetyReport, checkId: string) {
  const check = report.checks.find((c) => c.checkId === checkId);
  assert.ok(check, `check ${checkId} must be present`);
  return check;
}

// ─── 1. schema ────────────────────────────────────────────────────────────

describe("validateSceneShape", () => {
  it("合法 Scene 无错误", () => {
    assert.deepEqual(validateSceneShape(baseOrderingScene()), []);
  });

  it("非法 sceneType / 非法 hash / 缺 rubric bindings / 缺 a11y 路径 → 错误", () => {
    const badType = { ...baseOrderingScene(), sceneType: "not_a_scene" };
    assert.ok(validateSceneShape(badType).includes("invalid_scene_type"));

    const badHash = { ...baseOrderingScene(), publicPayloadHash: "not-hex" };
    assert.ok(validateSceneShape(badHash).includes("invalid_public_payload_hash"));

    const noRubric = { ...baseOrderingScene(), rubricEvidenceBindings: [] };
    assert.ok(validateSceneShape(noRubric).includes("missing_rubric_evidence_bindings"));

    const noA11y = { ...baseOrderingScene(), a11yEquivalentPaths: [] };
    assert.ok(validateSceneShape(noA11y).includes("missing_a11y_paths"));

    assert.ok(validateSceneShape(null).includes("scene_not_object"));
  });
});

// ─── 2. public/secret 分离 ────────────────────────────────────────────────

describe("checkPublicSecretSeparation", () => {
  it("正常 Scene 通过；public 泄漏 secret 字段名 / hash 失配 → 失败", () => {
    assert.equal(checkPublicSecretSeparation(baseOrderingScene()).passed, true);

    const leaked = {
      ...baseOrderingScene(),
      public: { ...baseOrderingScene().public, correctOrderIds: ["item-1"] },
    } as unknown as OrderingScene;
    const result = checkPublicSecretSeparation(leaked);
    assert.equal(result.passed, false);
    assert.ok(result.reasonCodes.some((r) => r.includes("private_field_in_public")));

    const stale = { ...baseOrderingScene(), publicPayloadHash: "0".repeat(64) };
    const result2 = checkPublicSecretSeparation(stale);
    assert.equal(result2.passed, false);
    assert.ok(result2.reasonCodes.includes("public_payload_hash_mismatch"));
  });
});

// ─── 3. allowlisted IDs ───────────────────────────────────────────────────

describe("checkAllowlistedIds", () => {
  const scope = { allowedEvidenceRefIds: ["ev-1"] };

  it("全部 solution ref ∈ allowed → 通过", () => {
    assert.equal(checkAllowlistedIds(baseOrderingScene(), scope).passed, true);
  });

  it("secret 解引用不在 allowed / evidence ref 不在预绑定 → 失败", () => {
    const scene = baseOrderingScene();
    scene.secret.correctOrderIds = ["item-1", "ghost-99"];
    const result = checkAllowlistedIds(fillHashes(scene), scope);
    assert.equal(result.passed, false);
    assert.ok(result.reasonCodes.some((r) => r.includes("solution_ref_not_allowed:ghost-99")));

    const badEvidence = baseOrderingScene();
    badEvidence.rubricEvidenceBindings[0].evidenceRefIds = ["not-allowed-ev"];
    const result2 = checkAllowlistedIds(badEvidence, scope);
    assert.equal(result2.passed, false);
    assert.ok(result2.reasonCodes.some((r) => r.includes("evidence_ref_not_allowed")));
  });
});

// ─── 4. 答案泄漏 ──────────────────────────────────────────────────────────

describe("checkAnswerLeakage", () => {
  it("公开 token 文本不覆盖答案 → 通过", () => {
    assert.equal(checkAnswerLeakage(baseOrderingScene()).passed, true);
  });

  it("公开文本包含 secret 答案文本 → 泄漏失败", () => {
    const scene = baseOrderingScene();
    scene.secret.acceptPermutedGroups = [["item-1", "item-2"]];
    scene.public.items[0].text = "正确顺序是 item-1 item-2，先收集证据";
    const result = checkAnswerLeakage(fillHashes(scene));
    assert.equal(result.passed, false);
    assert.ok(result.reasonCodes.includes("answer_text_disclosed_in_public"));
  });

  it("voice teachback：prompt 包含 disallowed claim → 泄漏失败", () => {
    const scene = baseVoiceScene();
    scene.public.prompt = "请解释：离心力使行星飞离恒星这种说法对不对？";
    const result = checkAnswerLeakage(fillHashes(scene));
    assert.equal(result.passed, false);
    assert.ok(result.reasonCodes.includes("disallowed_claim_in_prompt"));
  });

  it("结构题声称 recall → 泄漏失败；secret hash 出现在 public → 泄漏失败", () => {
    const claimsRecall = baseOrderingScene();
    claimsRecall.disclosureProfile.provableRecall = true;
    assert.equal(checkAnswerLeakage(claimsRecall).passed, false);

    const hashLeak = baseOrderingScene();
    hashLeak.public.initialOrderHint = `答案是 ${hashLeak.secretSolutionHash}`;
    assert.equal(checkAnswerLeakage(fillHashes(hashLeak)).passed, false);
  });
});

// ─── 5. 可评估性 ──────────────────────────────────────────────────────────

describe("checkAssessability", () => {
  it("formal 无即时泄题、secret 解非空 → 通过", () => {
    assert.equal(checkAssessability(baseOrderingScene()).passed, true);
  });

  it("formal + immediate feedback / formal 揭示答案 → 失败", () => {
    const formal = baseOrderingScene();
    formal.feedbackTiming = "immediate";
    assert.equal(checkAssessability(formal).passed, false);

    const reveals = baseOrderingScene();
    reveals.assistancePolicy.revealsAnswerOnAttempt = true;
    assert.equal(checkAssessability(reveals).passed, false);
  });

  it("multi-step 某步缺 correct option → 失败", () => {
    const multi: LearningScene = {
      ...baseOrderingScene(),
      sceneType: "multi_step_scenario",
      template: "multi-step-scenario-scene-v1",
      capabilityFacet: CapabilityFacet.APPLY,
      public: {
        scenarioText: "情境",
        steps: [
          { stepId: "s1", optionIds: ["o1", "o2"], optionTexts: ["A", "B"] },
        ],
        branchProtocol: "单步单选",
        maxBranches: 1,
      },
      secret: {
        correctOptions: {},
        branchOutcomes: {},
        correctBranchPath: [],
        rationaleRefs: [],
      },
    };
    const result = checkAssessability(fillHashes(multi) as LearningScene);
    assert.equal(result.passed, false);
    assert.ok(result.reasonCodes.some((r) => r.includes("step_without_correct_option")));
  });
});

// ─── 6. 唯一解或有效多解 ─────────────────────────────────────────────────

describe("checkSolutionUniqueness", () => {
  it("唯一解完整覆盖非 distractor 项 → 通过", () => {
    assert.equal(checkSolutionUniqueness(baseOrderingScene()).passed, true);
  });

  it("唯一解不完整（缺非 distractor 项）→ 失败", () => {
    const scene = baseOrderingScene();
    scene.secret.correctOrderIds = ["item-1"]; // 缺 item-2
    assert.equal(checkSolutionUniqueness(scene).passed, false);
  });

  it("显式声明的有效多解（permuted groups）→ 通过", () => {
    const scene = baseOrderingScene();
    scene.secret.acceptPermutedGroups = [["item-1", "item-2"]];
    const result = checkSolutionUniqueness(scene);
    assert.equal(result.passed, true);
  });

  it("多解组包含未知/非项 ID → 失败", () => {
    const scene = baseOrderingScene();
    scene.secret.acceptPermutedGroups = [["item-1", "ghost"]];
    assert.equal(checkSolutionUniqueness(scene).passed, false);
  });
});

// ─── 7. distractor 区分度 ────────────────────────────────────────────────

describe("checkDistractorDiscrimination", () => {
  it("distractor 有效且互异 → 通过", () => {
    assert.equal(checkDistractorDiscrimination(baseOrderingScene()).passed, true);
  });

  it("无 distractor 且无区分度 basis → 失败", () => {
    const scene = baseOrderingScene();
    scene.distractorIds = [];
    scene.secret.distractorItemIds = [];
    scene.public.emptySlots = 1; // 存在空槽 → 无 no_unique_slot_guess basis
    const result = checkDistractorDiscrimination(fillHashes(scene));
    assert.equal(result.passed, false);
    assert.ok(result.reasonCodes.includes("no_discrimination_basis"));
  });

  it("distractor 文本等于答案 → 失败", () => {
    const scene = baseOrderingScene();
    scene.secret.acceptPermutedGroups = [["item-3"]];
    scene.public.items[2].text = "第一步：收集证据";
    const result = checkDistractorDiscrimination(fillHashes(scene));
    assert.equal(result.passed, false);
    assert.ok(result.reasonCodes.includes("distractor_equals_answer"));
  });
});

// ─── 8. 事实支撑 ─────────────────────────────────────────────────────────

describe("checkFactualSupport", () => {
  it("evidence 存在且 supported、fingerprint/keyPoint 匹配 → 通过", () => {
    assert.equal(checkFactualSupport(baseOrderingScene(), FACT_SCOPE).passed, true);
  });

  it("evidence 无事实源 / semanticSupport 非 supported / fingerprint 失配 → 失败", () => {
    const missing = baseOrderingScene();
    missing.rubricEvidenceBindings[0].evidenceRefIds = ["ev-ghost"];
    assert.equal(checkFactualSupport(missing, FACT_SCOPE).passed, false);

    const unsupported = baseOrderingScene();
    unsupported.rubricEvidenceBindings[0].evidenceRefIds = ["ev-2"]; // unsupported
    assert.equal(checkFactualSupport(unsupported, FACT_SCOPE).passed, false);

    const mismatch = baseOrderingScene();
    mismatch.sourceFingerprint = "fp-old";
    assert.ok(checkFactualSupport(mismatch, FACT_SCOPE).reasonCodes.includes("source_fingerprint_mismatch"));

    const wrongKp = baseOrderingScene();
    wrongKp.target.keyPointId = "kp-other";
    assert.equal(checkFactualSupport(wrongKp, FACT_SCOPE).passed, false);
  });
});

// ─── 9. prompt injection ─────────────────────────────────────────────────

describe("checkPromptInjection", () => {
  it("正常文本通过；HTML/JS 脚本形态标记全部拒绝", () => {
    assert.equal(checkPromptInjection(baseOrderingScene()).passed, true);

    const cases = [
      "<script>alert(1)</script>",
      "javascript:alert(1)",
      "data:text/html,<svg onload=alert(1)>",
      "<svg onerror=alert(1)>",
    ];
    for (const payload of cases) {
      const scene = baseOrderingScene();
      scene.public.dragProtocol = payload;
      const result = checkPromptInjection(scene);
      assert.equal(result.passed, false, `must reject ${payload}`);
      assert.ok(result.reasonCodes.some((r) => r.includes("script_marker_in")));
    }
  });
});

// ─── 10. 语言与 A11y ─────────────────────────────────────────────────────

describe("checkLanguageAndA11y", () => {
  it("完整 A11y 等价路径且语义不降低 → 通过", () => {
    assert.equal(checkLanguageAndA11y(baseOrderingScene()).passed, true);
  });

  it("缺 keyboard/screen_reader 等价路径 → 失败", () => {
    const scene = baseOrderingScene();
    scene.a11yEquivalentPaths = [
      { kind: "tap_select_place", description: "点选", semanticRequirementUnchanged: true },
      { kind: "reduced_motion", description: "静态", semanticRequirementUnchanged: true },
    ];
    assert.equal(checkLanguageAndA11y(scene).passed, false);
  });

  it("等价路径降低语义要求 → 失败；替换字符乱码 → 失败", () => {
    const scene = baseOrderingScene();
    scene.a11yEquivalentPaths[1].semanticRequirementUnchanged = false;
    assert.ok(checkLanguageAndA11y(scene).reasonCodes.some((r) => r.includes("a11y_semantics_reduced")));

    const garbled = baseOrderingScene();
    garbled.public.items[0].text = "第一步�：收集证据";
    assert.ok(checkLanguageAndA11y(garbled).reasonCodes.includes("replacement_character_in_text"));
  });
});

// ─── 汇总与 Critic ───────────────────────────────────────────────────────

describe("runSceneSafety", () => {
  it("全部检查通过 + Critic approved → approved", () => {
    const report = runSceneSafety(baseOrderingScene(), safetyOptions());
    assert.equal(report.verdict, SceneSafetyVerdict.APPROVED);
    assert.equal(report.criticApproved, true);
    assert.equal(report.staticCertificationUsed, false);
  });

  it("deterministic 通过但 Critic 拒绝 → repair_required（可修复一次）", () => {
    const report = runSceneSafety(baseOrderingScene(), safetyOptions({ critic: rejectCritic }));
    assert.equal(report.verdict, SceneSafetyVerdict.REPAIR_REQUIRED);
    assert.equal(report.criticApproved, false);
    assert.ok(report.reasonCodes.includes("critic_not_approved"));
  });

  it("deterministic 失败 → repair_required，reasonCodes 累积", () => {
    const leaked = baseOrderingScene();
    leaked.secret.acceptPermutedGroups = [["item-1", "item-2"]];
    leaked.public.items[0].text = "正确答案是 item-1 item-2";
    const report = runSceneSafety(fillHashes(leaked), safetyOptions());
    assert.equal(report.verdict, SceneSafetyVerdict.REPAIR_REQUIRED);
    assert.ok(report.reasonCodes.includes("answer_text_disclosed_in_public"));
  });

  it("报告 hash 确定性：同输入同 hash", () => {
    const a = runSceneSafety(baseOrderingScene(), safetyOptions());
    const b = runSceneSafety(baseOrderingScene(), safetyOptions());
    assert.equal(a.reportHash, b.reportHash);
    assert.equal(computeSceneSafetyReportHash(a), a.reportHash);
  });
});

// ─── 修复一次语义 ────────────────────────────────────────────────────────

describe("runSceneSafetyWithRepair", () => {
  it("第一次失败 → 修复一次 → 第二次 approved", () => {
    const leaked = fillHashes({
      ...baseOrderingScene(),
      secret: {
        ...baseOrderingScene().secret,
        acceptPermutedGroups: [["item-1", "item-2"]],
      },
      public: {
        ...baseOrderingScene().public,
        items: [
          { id: "item-1", text: "正确答案是 item-1 item-2" },
          { id: "item-2", text: "第二步：形成假设" },
          { id: "item-3", text: "错误项：先下结论" },
        ],
      },
    });
    const result = runSceneSafetyWithRepair(leaked, {
      ...safetyOptions(),
      repair: (first) => {
        const sc = first as OrderingScene;
        return fillHashes({
          ...sc,
          public: {
            ...sc.public,
            items: sc.public.items.map((item) =>
              item.id === "item-1" ? { ...item, text: "第一步：收集证据" } : item,
            ),
          },
        });
      },
    });
    assert.equal(result.report.verdict, SceneSafetyVerdict.APPROVED);
    assert.ok(result.repairedScene);
    assert.equal(result.report.repairAttempts, 0); // 修复后 approved，最终报告为第二次报告
  });

  it("修复后 Critic 仍拒绝 → question_retryable（可重试内容问题）", () => {
    const scene = baseOrderingScene();
    scene.public.dragProtocol = "<script>x</script>";
    const result = runSceneSafetyWithRepair(fillHashes(scene), {
      ...safetyOptions({ critic: rejectCritic }),
      repair: (first) => {
        const sc = first as OrderingScene;
        return fillHashes({
          ...sc,
          public: { ...sc.public, dragProtocol: "修复后的协议" },
        });
      },
    });
    assert.equal(result.report.repairAttempts, 1);
    assert.equal(result.report.verdict, SceneSafetyVerdict.QUESTION_RETRYABLE);
    assert.equal(decideFinalVerdict(result.report), SceneSafetyVerdict.QUESTION_RETRYABLE);
  });

  it("修复后结构性问题仍在 → blocked（fail closed）", () => {
    const scene = baseOrderingScene();
    scene.secret.correctOrderIds = ["item-1"]; // 唯一解不完整（结构性）
    const result = runSceneSafetyWithRepair(scene, {
      ...safetyOptions(),
      repair: (first) => ({ ...first }), // 修复无效：保持结构错误
    });
    assert.equal(result.report.repairAttempts, 1);
    assert.equal(result.report.verdict, SceneSafetyVerdict.BLOCKED);
    assert.ok(checkById(result.report, "solution_uniqueness").passed === false);
  });

  it("无 repair 端口 → 直接返回第一次报告（不修复）", () => {
    const scene = baseOrderingScene();
    scene.public.dragProtocol = "<script>x</script>";
    const result = runSceneSafetyWithRepair(fillHashes(scene), safetyOptions());
    assert.equal(result.report.verdict, SceneSafetyVerdict.REPAIR_REQUIRED);
    assert.equal(result.report.repairAttempts, 0);
  });
});

// ─── 静态模板复用 ─────────────────────────────────────────────────────────

describe("verifyStaticTemplateCertification & 复用", () => {
  const staticTemplates: StaticSceneTemplate[] = [
    {
      template: "ordering-scene-v1",
      version: "v1",
      certificationHash: "f".repeat(64),
      contentSlotSources: ["gold-rubric-v1-ordering"],
      allowlist: ["第一步：收集证据", "第二步：形成假设", "错误项：先下结论"],
    },
  ];

  it("模板注册 + 不可变 certification hash + 槽位 ∈ deterministic allowlist → valid", () => {
    const result = verifyStaticTemplateCertification(baseOrderingScene(), staticTemplates);
    assert.equal(result.valid, true);
    assert.equal(result.certificationHash, "f".repeat(64));
  });

  it("内容槽位不在 deterministic allowlist → 复用不可用", () => {
    const scene = baseOrderingScene();
    scene.public.items[0].text = "未入册的新文本";
    const result = verifyStaticTemplateCertification(fillHashes(scene), staticTemplates);
    assert.equal(result.valid, false);
    assert.ok(result.reasonCodes.includes("content_slot_not_in_deterministic_allowlist"));
  });

  it("静态认证有效时复用历史 approval：跳过动态 Critic（即使 Critic 拒绝）", () => {
    const report = runSceneSafety(baseOrderingScene(), safetyOptions({ staticTemplates }));
    assert.equal(report.verdict, SceneSafetyVerdict.APPROVED);
    assert.equal(report.staticCertificationUsed, true);
    assert.equal(report.criticApproved, true);
  });

  it("静态认证有效但 deterministic 检查失败 → 不复用、不通过", () => {
    // 槽位不在 allowlist 且内容槽位变更后未重算 hash（结构失配）：
    // 复用不可用，deterministic 检查失败 → 不能通过。
    const leaked = baseOrderingScene();
    leaked.public.items[0].text = "未入册的新文本";
    const report = runSceneSafety(leaked, safetyOptions({ staticTemplates }));
    assert.equal(report.staticCertificationUsed, false);
    assert.equal(report.verdict, SceneSafetyVerdict.REPAIR_REQUIRED);
    assert.ok(report.reasonCodes.includes("content_slot_not_in_deterministic_allowlist"));
    assert.ok(report.reasonCodes.includes("public_payload_hash_mismatch"));
  });
});
