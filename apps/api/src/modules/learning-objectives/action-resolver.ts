/**
 * Plan 23 W2-15/W2-16：LearningObjective Primary Action 解析器（纯函数）。
 *
 * 优先级（§33.1 W3-03 规则表；服务端唯一裁决，前端不得按 label/本地时间推断）：
 *   1. lifecycle=superseded → view_successor；
 *   2. lifecycle=archived/blocked_content_upgrade → none / refresh；
 *   3. activeRun 存在（可恢复）→ resume_run；
 *   4. review due（携带精确 scheduleId/generation）→ create_review_run；
 *   5. initial validation ready → create_run（origin 由入口提供）；
 *   5.5. Reveal 过的题 → practice_only（练习照给，正式验证按时点等）；
 *   5.6. initial validation deferred 且无练习入口 → wait_for_initial_validation（§7.5）；
 *   6. 其余 → create_run 或 none。
 */
import type { LearningObjectivePrimaryActionV3 } from "@ailearn/shared";

export interface ActionResolverInputV3 {
  objectiveId: string;
  lifecycle: "active" | "archived" | "superseded" | "blocked_content_upgrade";
  successorObjectiveId: string | null;
  successorCardId: string | null;
  hasActiveCard: boolean;
  cardId: string | null;
  activeRun: { runId: string } | null;
  reviewDue: { scheduleId: string; generation: number } | null;
  initialReady: { reminderId: string; qualificationNotBefore: string } | null;
  /** initial validation 存在但 deferred（未到资格时间）→ wait_for_initial_validation。 */
  initialDeferred: { reminderId: string; qualificationNotBefore: string } | null;
  /** Reveal/Exposure 后由服务端决定（§7.4）；客户端不得自判。 */
  practiceOnly: boolean;
  practiceReasonCodes: string[];
}

function cardStart(objectiveId: string, cardId: string) {
  return {
    version: 2 as const,
    originV2: { kind: "card" as const, cardId, objectiveId },
    goal: "stabilize" as const,
    requestedTimeBudgetSeconds: 180,
    responsePreference: "adaptive" as const,
  };
}

/** 解析唯一主行动；永不返回 label 猜测。 */
export function resolvePrimaryActionV3(
  input: ActionResolverInputV3,
): LearningObjectivePrimaryActionV3 {
  const objectiveId = input.objectiveId;
  if (input.lifecycle === "superseded") {
    if (input.successorObjectiveId) {
      return {
        kind: "view_successor",
        successorObjectiveId: input.successorObjectiveId,
        successorCardId: input.successorCardId ?? null,
      };
    }
    return { kind: "none" };
  }
  if (input.lifecycle === "archived") {
    return { kind: "none" };
  }
  if (input.lifecycle === "blocked_content_upgrade") {
    return { kind: "refresh" };
  }

  // resume > review due > initial ready > practice > create_run
  if (input.activeRun) {
    return { kind: "resume_run", runId: input.activeRun.runId, objectiveId };
  }
  if (input.reviewDue) {
    if (input.reviewDue.generation < 1) return { kind: "refresh" };
    return {
      kind: "create_review_run",
      objectiveId,
      label: "开始到期复习",
      start: {
        version: 2,
        originV2: {
          kind: "review",
          scheduleId: input.reviewDue.scheduleId,
          objectiveId,
          scheduleGeneration: input.reviewDue.generation,
        },
        goal: "stabilize",
        requestedTimeBudgetSeconds: 180,
        responsePreference: "adaptive",
      },
    };
  }
  if (input.initialReady) {
    if (!input.cardId) return { kind: "refresh" };
    return {
      kind: "create_run",
      objectiveId,
      label: "开始首次验证",
      start: cardStart(objectiveId, input.cardId),
    };
  }
  // §7.4 第 6 条：Reveal 之后仍然可练（2026-09-20 实走复盘 #9 修正了这条的
  // 优先级实现——此前 `initialDeferred` 排在 `practiceOnly` 前面）。用户点了
  // 「查看答案」之后，24 小时内连练习入口都被禁用，界面上只剩一个灰色按钮，
  // 等于用一次好奇换来一整天的死路。
  // 而这个冷却真正要保护的是**正式验证的可信度**，那件事并不靠 CTA 挡住：
  // 冻结快照的 `publishedTargetEligibility` 一旦判定近期 reveal，planner 就把
  // purpose 钳成 practice、trust ceiling 钳成 practice_only（run-planner §16.4），
  // 答案已看过的这一题拿不到掌握证据。所以正确的裁决是「练习照给、
  // 正式验证按时点等」，而不是整卡停用。
  // 例外：审核阶段看过候选答案时曝光记在候选账本、不在 `learning_exposures_v2`，
  // 于是 `practiceOnly=false`，落到下面的 `wait_for_initial_validation` 分支。
  if (input.practiceOnly) {
    if (!input.cardId) return { kind: "refresh" };
    return {
      kind: "practice_only",
      objectiveId,
      reasonCodes: input.practiceReasonCodes.length > 0 ? input.practiceReasonCodes : ["exposed"],
      label: "带着参考答案练一下",
      start: cardStart(objectiveId, input.cardId),
      formalValidationNotBefore: input.initialDeferred?.qualificationNotBefore ?? null,
    };
  }
  if (input.initialDeferred) {
    return {
      kind: "wait_for_initial_validation",
      reminderId: input.initialDeferred.reminderId,
      qualificationNotBefore: input.initialDeferred.qualificationNotBefore,
    };
  }
  if (input.hasActiveCard) {
    if (!input.cardId) return { kind: "refresh" };
    return {
      kind: "create_run",
      objectiveId,
      label: "开始学习",
      start: cardStart(objectiveId, input.cardId),
    };
  }
  if (input.lifecycle === "active") {
    // 有目标但没有可执行路径（如 missing origin 修复中）→ 刷新入口
    return { kind: "refresh" };
  }
  return { kind: "none" };
}
