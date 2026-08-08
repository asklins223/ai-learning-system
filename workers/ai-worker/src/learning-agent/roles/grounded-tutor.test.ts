/**
 * Grounded Tutor 单测（阶段 07 / W6 任务 07-7，§5.7）。
 *
 * 覆盖（验收，07-w6 任务 07-7）：
 * - 有界 detour：绑定 sessionId+episodeId+targetId+questionId；一次一个问题
 *   （questionCount 字面量 1，无「再问第二个问题」动作）；
 * - 最多两次澄清：第 3 次 clarify allowed=false；
 * - 固定结束动作只有「返回原航程 / 结束」，任意态可结束，ended 终态不可再动作；
 * - 问题标记是 Should 动作：flag 未开 allowed=false，flag 开可保存；
 * - Must 动作白名单固定 5 个；Should 动作 flag 未开不可见（空数组）；
 * - 支持层级拆分：current_target（含 derived_from_current_target 绑定
 *   premiseRefs+derivationType）/ workspace_knowledge / extended_explanation /
 *   unknown；buildTutorAnswer 结构校验 fail-closed；
 * - 不写真值：答案结构无 mastery/card/relation/schedule 字段，proposals 带
 *   requiresUserConfirmation: true 字面量；
 * - 独立 system policy：绑定模型快照、禁止越权输出、允许工具与 03-4 网关一致。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { LearningAgentRole, LearningToolId } from "../types.ts";
import {
  GroundedTutorError,
  MAX_TUTOR_CLARIFICATIONS,
  TutorDerivationType,
  TutorDetourAction,
  TutorDetourStep,
  TutorOutputForm,
  TutorProposalKind,
  TutorSupportMode,
  buildGroundedTutorSystemPolicy,
  buildTutorAnswer,
  createGroundedTutorRole,
  createTutorDetour,
  isTutorEndAction,
  resolveTutorVisibleActions,
  transitionTutorDetour,
  validateTutorSegment,
  type TutorDetourBinding,
  type TutorSegment,
} from "./grounded-tutor.ts";

// ─── fixtures ─────────────────────────────────────────────────────────────

const BINDING: TutorDetourBinding = {
  sessionId: "sess-1",
  episodeId: "ep-1",
  targetId: "kp-1",
  questionId: "q-1",
};

function detourState(overrides?: Partial<ReturnType<typeof createTutorDetour>>) {
  return {
    ...createTutorDetour({ detourId: "detour-1", binding: BINDING }),
    ...overrides,
  };
}

function currentTargetSegment(overrides?: Partial<TutorSegment>): TutorSegment {
  return {
    segmentId: "seg-1",
    text: "氧气是燃烧反应的氧化剂。",
    supportMode: TutorSupportMode.CURRENT_TARGET,
    evidenceRefs: ["ev-1"],
    ...overrides,
  };
}

// ─── 1. 角色规格 ─────────────────────────────────────────────────────────

test("createGroundedTutorRole：GROUNDED_TUTOR + 4 个允许工具，无 forbidden 产品动作", () => {
  const spec = createGroundedTutorRole();
  assert.equal(spec.role, LearningAgentRole.GROUNDED_TUTOR);
  assert.deepEqual([...spec.allowedToolIds].sort(), [
    LearningToolId.OFFER_SHORT_EXPLANATION,
    LearningToolId.READ_CURRENT_TARGET_EVIDENCE,
    LearningToolId.RENDER_CURRENT_TARGET_SCENE,
    LearningToolId.RENDER_EVIDENCE_CARD,
  ]);
  // 越权产品动作不在 allowlist（enter-practice/confirm-and-lock/submit/commit）
  for (const forbidden of ["enter-practice", "confirm-and-lock", "submit", "commit"]) {
    assert.ok(!(spec.allowedToolIds as readonly string[]).includes(forbidden), forbidden);
  }
});

// ─── 2. 有界 detour：绑定四元组 + 一次一个问题 ────────────────────────────

test("createTutorDetour：绑定 sessionId+episodeId+targetId+questionId，questionCount=1", () => {
  const state = createTutorDetour({ detourId: "detour-1", binding: BINDING });
  assert.equal(state.detourId, "detour-1");
  assert.deepEqual(state.binding, BINDING);
  assert.equal(state.step, TutorDetourStep.QUESTION_ASKED);
  assert.equal(state.clarificationCount, 0);
  assert.equal(state.questionCount, 1);
  assert.equal(state.endedBy, null);
});

test("一次一个问题：状态机不存在「再问第二个问题」动作，questionId 创建后冻结", () => {
  // TutorDetourAction 集合是字面量枚举，仅含 clarify/produce_answer/结束/问题标记，
  // 没有 ask_question / change_question——一次一个问题由类型面保证。
  const knownActions = Object.values(TutorDetourAction);
  assert.ok(!knownActions.includes("ask_question" as never));
  assert.ok(!knownActions.includes("change_question" as never));
  // 且 detour 记录无 messages 数组（不保留无限滚动聊天历史）。
  const state = createTutorDetour({ detourId: "d", binding: BINDING });
  assert.ok(!("messages" in state));
});

// ─── 3. 最多两次澄清 ─────────────────────────────────────────────────────

test("澄清最多两次：第 1、2 次 allowed，第 3 次拒绝且状态不变", () => {
  let state = detourState();
  const r1 = transitionTutorDetour(state, TutorDetourAction.CLARIFY);
  assert.equal(r1.allowed, true);
  assert.equal(r1.state.clarificationCount, 1);
  assert.equal(r1.state.step, TutorDetourStep.CLARIFYING);

  state = r1.state;
  const r2 = transitionTutorDetour(state, TutorDetourAction.CLARIFY);
  assert.equal(r2.allowed, true);
  assert.equal(r2.state.clarificationCount, 2);

  const r3 = transitionTutorDetour(r2.state, TutorDetourAction.CLARIFY);
  assert.equal(r3.allowed, false);
  assert.ok(r3.reason?.includes("上限"));
  assert.equal(r3.state.clarificationCount, 2); // 状态不变
  assert.equal(MAX_TUTOR_CLARIFICATIONS, 2);
});

test("答案产出后不再澄清", () => {
  const answered = detourState({ step: TutorDetourStep.ANSWERED });
  const r = transitionTutorDetour(answered, TutorDetourAction.CLARIFY);
  assert.equal(r.allowed, false);
  assert.ok(r.reason?.includes("答案已产出"));
});

test("produce_answer 推进到 ANSWERED（待独立 Critic 逐段检查）", () => {
  const r = transitionTutorDetour(detourState(), TutorDetourAction.PRODUCE_ANSWER);
  assert.equal(r.allowed, true);
  assert.equal(r.state.step, TutorDetourStep.ANSWERED);
});

// ─── 4. 固定结束动作：返回原航程 / 结束 ───────────────────────────────────

test("固定结束动作只有 return_to_origin 与 end_session", () => {
  assert.deepEqual(isTutorEndAction("return_to_origin"), true);
  assert.deepEqual(isTutorEndAction("end_session"), true);
  assert.deepEqual(isTutorEndAction("save_question_marker"), false);
  assert.deepEqual(isTutorEndAction("re_explain"), false);
});

test("return_to_origin / end_session 从任意态结束，ended 终态不可再动作", () => {
  for (const action of [TutorDetourAction.RETURN_TO_ORIGIN, TutorDetourAction.END_SESSION]) {
    const r = transitionTutorDetour(detourState(), action);
    assert.equal(r.allowed, true);
    assert.equal(r.state.step, TutorDetourStep.ENDED);
    assert.equal(r.state.endedBy, action);

    // 终态：不能 clarify / 不能再次结束
    const again = transitionTutorDetour(r.state, action);
    assert.equal(again.allowed, false);
    assert.ok(again.reason?.includes("已结束"));
    const clarify = transitionTutorDetour(r.state, TutorDetourAction.CLARIFY);
    assert.equal(clarify.allowed, false);
  }
});

// ─── 5. 问题标记：Should flag 开关 ────────────────────────────────────────

test("保存为问题标记是 Should 动作：flag 未开 allowed=false，flag 开 allowed=true", () => {
  const off = transitionTutorDetour(
    detourState(),
    TutorDetourAction.SAVE_QUESTION_MARKER,
    { shouldFlag: false },
  );
  assert.equal(off.allowed, false);
  assert.ok(off.reason?.includes("Should"));

  const on = transitionTutorDetour(
    detourState(),
    TutorDetourAction.SAVE_QUESTION_MARKER,
    { shouldFlag: true },
  );
  assert.equal(on.allowed, true);
  assert.equal(on.state.questionMarkerSaved, true);

  // 重复保存拒绝
  const again = transitionTutorDetour(on.state, TutorDetourAction.SAVE_QUESTION_MARKER, {
    shouldFlag: true,
  });
  assert.equal(again.allowed, false);
});

// ─── 6. Must 动作白名单 ──────────────────────────────────────────────────

test("Must 可见动作固定 5 个；Should flag 未开时 Should 动作不可见（空数组）", () => {
  const off = resolveTutorVisibleActions(false);
  assert.deepEqual([...off.must].sort(), [
    "end_session",
    "re_explain",
    "render_practice_scene",
    "return_to_origin",
    "view_evidence",
  ]);
  assert.deepEqual(off.should, []);
  assert.deepEqual([...off.endActions].sort(), ["end_session", "return_to_origin"]);

  const on = resolveTutorVisibleActions(true);
  assert.deepEqual([...on.must].sort(), [...off.must].sort());
  assert.deepEqual([...on.should].sort(), [
    "compare_across_targets",
    "extended_explanation",
    "propose_new_card",
    "propose_relation_candidate",
    "save_question_marker",
    "workspace_search",
  ]);
  // 固定结束动作必须是 Must 子集（返回/结束始终可见）。
  for (const end of on.endActions) {
    assert.ok((on.must as readonly string[]).includes(end), end);
  }
});

// ─── 7. 支持层级拆分 + 答案构建校验 ───────────────────────────────────────

test("validateTutorSegment：current_target 段必须绑定 evidenceRefs 或 derivedFromCurrentTarget", () => {
  assert.deepEqual(validateTutorSegment(currentTargetSegment()), []);
  // 无任何引用 → 错误
  assert.ok(
    validateTutorSegment(
      currentTargetSegment({ evidenceRefs: [], derivedFromCurrentTarget: undefined }),
    ).length > 0,
  );
  // 推导段必须绑定 premiseRefs + derivationType
  assert.deepEqual(
    validateTutorSegment(
      currentTargetSegment({
        evidenceRefs: [],
        derivedFromCurrentTarget: {
          premiseRefs: ["ev-1", "ev-2"],
          derivationType: TutorDerivationType.BOUNDED_DERIVATION,
        },
      }),
    ),
    [],
  );
  assert.ok(
    validateTutorSegment(
      currentTargetSegment({
        evidenceRefs: [],
        derivedFromCurrentTarget: {
          premiseRefs: [],
          derivationType: TutorDerivationType.BOUNDED_DERIVATION,
        },
      }),
    ).length > 0,
    "premiseRefs 为空 → 拒绝",
  );
  assert.ok(
    validateTutorSegment(
      currentTargetSegment({
        evidenceRefs: [],
        derivedFromCurrentTarget: {
          premiseRefs: ["ev-1"],
          derivationType: "not_a_derivation" as never,
        },
      }),
    ).length > 0,
    "非法 derivationType → 拒绝",
  );
});

test("validateTutorSegment：unknown 段必须声明 unknownDeclaration，扩展说明段必须声明 extendedExplanation", () => {
  assert.deepEqual(
    validateTutorSegment({
      segmentId: "u1",
      text: "我不知道该机制在此场景下的完整边界。",
      supportMode: TutorSupportMode.UNKNOWN,
      unknownDeclaration: true,
    }),
    [],
  );
  assert.ok(
    validateTutorSegment({
      segmentId: "u1",
      text: "我不确定。",
      supportMode: TutorSupportMode.UNKNOWN,
    }).length > 0,
    "unknown 段未显式声明 → 拒绝",
  );
  assert.deepEqual(
    validateTutorSegment({
      segmentId: "e1",
      text: "扩展背景：该概念最早出现在……",
      supportMode: TutorSupportMode.EXTENDED_EXPLANATION,
      extendedExplanation: true,
    }),
    [],
  );
  assert.ok(
    validateTutorSegment({
      segmentId: "e1",
      text: "扩展背景……",
      supportMode: TutorSupportMode.EXTENDED_EXPLANATION,
    }).length > 0,
    "扩展说明段未标注 → 拒绝",
  );
});

test("buildTutorAnswer：四层支持层级可构建；空答案 / 非法段抛 GroundedTutorError", () => {
  const answer = buildTutorAnswer({
    answerId: "ans-1",
    binding: BINDING,
    outputForm: TutorOutputForm.EVIDENCE_CARD,
    segments: [
      currentTargetSegment(),
      {
        segmentId: "ws-1",
        text: "工作区其他 Key Point 的相关表述。",
        supportMode: TutorSupportMode.WORKSPACE_KNOWLEDGE,
      },
      {
        segmentId: "ext-1",
        text: "扩展说明（不进共享真值）。",
        supportMode: TutorSupportMode.EXTENDED_EXPLANATION,
        extendedExplanation: true,
      },
      {
        segmentId: "unk-1",
        text: "该问题当前没有可引用的 canonical 来源。",
        supportMode: TutorSupportMode.UNKNOWN,
        unknownDeclaration: true,
      },
    ],
    proposals: [
      {
        kind: TutorProposalKind.NEW_CARD,
        description: "提议把该边界整理成新卡，需用户确认后重新走 Generation Supervisor。",
        requiresUserConfirmation: true,
      },
    ],
  });
  assert.equal(answer.segments.length, 4);
  assert.equal(answer.segments[0]!.supportMode, TutorSupportMode.CURRENT_TARGET);
  assert.equal(answer.segments[3]!.supportMode, TutorSupportMode.UNKNOWN);
  assert.equal(answer.proposals[0]!.requiresUserConfirmation, true);

  assert.throws(
    () => buildTutorAnswer({ answerId: "a", binding: BINDING, outputForm: TutorOutputForm.SHORT_EXPLANATION, segments: [] }),
    GroundedTutorError,
  );
  assert.throws(
    () =>
      buildTutorAnswer({
        answerId: "a",
        binding: BINDING,
        outputForm: TutorOutputForm.SHORT_EXPLANATION,
        segments: [currentTargetSegment({ evidenceRefs: [], derivedFromCurrentTarget: undefined })],
      }),
    GroundedTutorError,
  );
});

// ─── 8. 不写真值：无 mastery / card / relation / schedule 写路径 ──────────

test("Tutor 答案不写掌握/卡/关系：返回结构无这些字段，proposals 只是提议", () => {
  const answer = buildTutorAnswer({
    answerId: "ans-2",
    binding: BINDING,
    outputForm: TutorOutputForm.CONDITIONAL_VARIANT,
    segments: [
      currentTargetSegment({
        evidenceRefs: [],
        derivedFromCurrentTarget: {
          premiseRefs: ["ev-1"],
          derivationType: TutorDerivationType.DIRECT_EVIDENCE,
        },
      }),
    ],
  });
  // 类型面（无 mastery/canonicalCard/publishedRelation/schedule 字段）+ 运行时断言。
  assert.ok(!("mastery" in answer));
  assert.ok(!("canonicalCard" in answer));
  assert.ok(!("publishedSemanticRelation" in answer));
  assert.ok(!("schedule" in answer));
  assert.equal(answer.segments[0]!.derivedFromCurrentTarget?.premiseRefs[0], "ev-1");
  assert.equal(
    answer.segments[0]!.derivedFromCurrentTarget?.derivationType,
    TutorDerivationType.DIRECT_EVIDENCE,
  );
  // 每个 proposal 都要求用户确认后重新走生成/关系治理。
  for (const proposal of answer.proposals) {
    assert.equal(proposal.requiresUserConfirmation, true);
  }
});

// ─── 9. 独立 system policy ───────────────────────────────────────────────

test("buildGroundedTutorSystemPolicy：独立 policy 绑定模型快照、禁止越权输出、工具与网关一致", () => {
  const policy = buildGroundedTutorSystemPolicy({
    provider: "mock",
    model: "tutor-model",
    version: "v1",
    snapshotHash: "h".repeat(64),
  });
  assert.equal(policy.role, LearningAgentRole.GROUNDED_TUTOR);
  assert.equal(policy.policyId, "grounded-tutor-policy-v1");
  assert.ok(policy.forbiddenOutputs.includes("mastery"));
  assert.ok(policy.forbiddenOutputs.includes("canonical_card"));
  assert.ok(policy.forbiddenOutputs.includes("published_semantic_relation"));
  assert.ok(policy.forbiddenOutputs.includes("schedule"));
  assert.ok(policy.forbiddenOutputs.includes("personal_understanding_state"));
  assert.deepEqual([...policy.allowedToolIds].sort(), [
    LearningToolId.OFFER_SHORT_EXPLANATION,
    LearningToolId.READ_CURRENT_TARGET_EVIDENCE,
    LearningToolId.RENDER_CURRENT_TARGET_SCENE,
    LearningToolId.RENDER_EVIDENCE_CARD,
  ]);
  assert.ok(policy.systemPrompt.includes("sessionId + episodeId + targetId + questionId"));
  assert.ok(policy.systemPrompt.includes("最多两次澄清"));
  assert.ok(policy.systemPrompt.includes("derived_from_current_target"));
});
