/**
 * Plan 23 W2-15/W2-16：LearningObjective Primary Action 解析器（纯函数）。
 *
 * 优先级（§33.1 W3-03 规则表；服务端唯一裁决，前端不得按 label/本地时间推断）：
 *   1. lifecycle=superseded → view_successor；
 *   2. lifecycle=archived/blocked_content_upgrade → none / refresh；
 *   3. activeRun 存在（可恢复）→ resume_run；
 *   4. review due（携带精确 scheduleId/generation）→ create_review_run；
 *   5. initial validation ready → create_run；
 *   5.5. Reveal 过的题 → practice_only（练习照给，正式验证按时点等）；
 *   5.6. initial validation deferred 且无练习入口 → wait_for_initial_validation（§7.5）；
 *   6. active 且没有更靠前的情况 → create_run（§3.2「没有学习记录 → 开始学习」；
 *      最近一轮判成 `needs_repair`／`partial` 时**同一档换动词**为「接着弄懂上次没弄通的地方」
 *      ——39d W4-2 第三刀收尾，不新增 kind，start 载荷一字不变）。
 *
 * 2026-09-25（39d W4-2）：**有没有学习卡不再决定给不给入口**，只决定那一轮走哪一种
 * origin（有卡 `card`、无卡 `today`）。此前无卡的 active 目标一律落到 `refresh`，
 * 而 W3-4 已经把无卡目标的冻结链与「提交→评估→结算」整条走通了——一个永远
 * 只会"重新读取"的主行动，等于把已经能做的事藏起来。真开不了的那种（零依据）
 * 由服务端回具体原因（`run-errors.ts` 的 `target_evidence_missing`），不是灰色按钮。
 */
import type { AnswerModePreferenceV1, LearningObjectivePrimaryActionV3 } from "@ailearn/shared";
import { answerModeToResponsePreference, learningRunOutcomeSchema, startRunOriginV2 } from "@ailearn/shared";

export interface ActionResolverInputV3 {
  objectiveId: string;
  lifecycle: "active" | "archived" | "superseded" | "blocked_content_upgrade";
  successorObjectiveId: string | null;
  successorCardId: string | null;
  cardId: string | null;
  activeRun: { runId: string } | null;
  /** A published formal result already exists for this objective. */
  hasPriorFormalResult: boolean;
  reviewDue: { scheduleId: string; generation: number } | null;
  initialReady: { reminderId: string; qualificationNotBefore: string } | null;
  /** initial validation 存在但 deferred（未到资格时间）→ wait_for_initial_validation。 */
  initialDeferred: { reminderId: string; qualificationNotBefore: string } | null;
  /** Reveal/Exposure 后由服务端决定（§7.4）；客户端不得自判。 */
  practiceOnly: boolean;
  practiceReasonCodes: string[];
  /**
   * 最近一轮已落库的结论（`learning_runs.result` 里的 `outcome` 原文）；还没答过就是 null。
   * **哪些结论算"明显缺口"由本文件判**（`objectiveHasRecentGapV3`），不在列表／详情／星图
   * 三处各判一次——那三处的取数形状不一样，各判一次迟早只对上一半。
   */
  lastResultOutcome: string | null;
  /**
   * 账号「作答方式」偏好（`any` = 未设置）。必填：这条偏好过去只在设置页显示，
   * 主行动里 `responsePreference` 一律硬写 `adaptive`（doc 34 L15）——用户选了
   * 「语音」，开出来的 Run 仍然是文字优先。
   * 装配层在**逐个目标的循环之外**读一次（`readAnswerModePreference`），把值传进来。
   */
  answerModePreference: AnswerModePreferenceV1;
}

function startPayload(
  objectiveId: string,
  cardId: string | null,
  answerModePreference: AnswerModePreferenceV1,
) {
  return {
    version: 2 as const,
    // 有卡走 `card`；**没卡走 `today`**——这条规则本身在共享合同 `startRunOriginV2` 里，
    // 因为两处都要用它：这里给页面，worker 的 `buildActionPayload` 给她那句「开始学习」
    // （那侧此前只会 JOIN 卡，无卡就报"当前不可用"，页面却点得动）。
    // 零依据、真的开不了的那种，服务端回的是
    // 「这个目标还没有可依据的原稿内容」那一句真因——入口不因为可能失败就藏起来。
    originV2: startRunOriginV2({ objectiveId, cardId }),
    goal: "stabilize" as const,
    requestedTimeBudgetSeconds: 180,
    responsePreference: answerModeToResponsePreference(answerModePreference),
  };
}

/**
 * §3.2 第三种情况「最近一轮仍有明显缺口」里的那两档结论。
 *
 * `not_assessable` **不算**缺口——那一轮是"判不了"，不是"没弄通"，说成缺口是把系统的
 * 无能报成用户的缺陷。`practice_completed`／`skipped`／`declared_unable` 同理：
 * 它们都不是一句"这里还有洞"的判断。
 */
const RECENT_GAP_OUTCOMES: readonly string[] = ["needs_repair", "partial"];

export function objectiveHasRecentGapV3(lastResultOutcome: string | null): boolean {
  return lastResultOutcome !== null && RECENT_GAP_OUTCOMES.includes(lastResultOutcome);
}

/**
 * 从一批 run 行里取「最近一轮已经判出结论的那一条」，三处装配（详情页、列表、星图）
 * 共用这一个判据：**只看 `result` 里带得出合法结论的行，按 `updatedAt`（什么时候判完的）
 * 取最新的一条**。
 *
 * 为什么不按 `createdAt`：先开后交、后开后交的两轮会因此选中不同的那一轮，
 * 而详情页过去是独自用一条 `ORDER BY updated_at DESC LIMIT 1` 的 SQL 做这件事的
 * （本轮改成用它）——两边一错位，同一个目标的主动词就会在两块屏上不一样。
 * `runId` 与 `updatedAt` 一起回，是因为结果页那笔账（`personal.latestResult`）要的正是这两个。
 */
export function pickLatestCompletedRunV3(
  rows: readonly { runId: string; outcome: unknown; updatedAt: Date | string }[],
): { runId: string; outcome: string; updatedAt: Date | string } | null {
  let latest: { runId: string; outcome: string; updatedAt: Date | string; at: number } | null = null;
  for (const row of rows) {
    if (typeof row.outcome !== "string" || row.outcome.length === 0) continue;
    if (!learningRunOutcomeSchema.safeParse(row.outcome).success) continue;
    const at = new Date(row.updatedAt).valueOf();
    if (!Number.isFinite(at)) continue;
    if (latest === null || at > latest.at) latest = { runId: row.runId, outcome: row.outcome, updatedAt: row.updatedAt, at };
  }
  return latest === null ? null : { runId: latest.runId, outcome: latest.outcome, updatedAt: latest.updatedAt };
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
        responsePreference: answerModeToResponsePreference(input.answerModePreference),
      },
    };
  }
  if (input.initialReady) {
    return {
      kind: "create_run",
      objectiveId,
      label: input.hasPriorFormalResult ? "再做一次正式挑战" : "开始首次验证",
      start: startPayload(objectiveId, input.cardId, input.answerModePreference),
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
    return {
      kind: "practice_only",
      objectiveId,
      reasonCodes: input.practiceReasonCodes.length > 0 ? input.practiceReasonCodes : ["exposed"],
      label: "带着参考答案练一下",
      start: startPayload(objectiveId, input.cardId, input.answerModePreference),
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
  // §3.2 的第一种与第三种情况：**同一个动作，两种上下文**。
  // 没有学习记录 ⇒「开始学习」；最近一轮判出明显缺口 ⇒「接着弄懂上次没弄通的地方」。
  // 这里刻意**不新增 action kind**：两种情况开出去的那一轮是同一件事（`startPayload` 一模一样），
  // 差别只在"为什么要再答一次"。造第二个 kind 就是让列表／详情／星图／伴星四处各认一遍新分支，
  // 而动词与去处会因此可能不一致（31 号文档 P9 那条病）。
  // 有没有卡不再决定**给不给**这个入口，只决定开出去那一轮走哪一种 origin。
  return {
    kind: "create_run",
    objectiveId,
    label: objectiveHasRecentGapV3(input.lastResultOutcome) ? "接着弄懂上次没弄通的地方" : "开始学习",
    start: startPayload(objectiveId, input.cardId, input.answerModePreference),
  };
}
