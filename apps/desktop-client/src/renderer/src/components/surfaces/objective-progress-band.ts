/**
 * 「我走到哪了」的唯一一份读数（31 号文档 §9.1，批次 B10）。
 *
 * 这条链路此前没有任何一处能回答这个问题：作答页右上角在 checkpoint 态只是一个
 * 裸词「进度」后面什么都不带，结算页只有本次的 0/1 计数，列表是三个互不相干的数。
 *
 * 单位是**位置**，不是百分比、也不是掌握度——合同禁止客户端自行推断掌握度
 * （`23-…:556/:574`），所以这里只做一件事：把服务端**已经裁决**的那一个值
 * （`personalState.state`，或结算页的 `result.outcome`）映射到三段里的第几段。
 * 这和 `objectiveStateTone` 把十个状态映射到四种色调是同一类查表，不是推导。
 *
 * 认不出来的值一律返回 null（界面上显示 `—`，见 DESIGN.md:178），不猜。
 */
import type { ObjectivePersonalStateV3 } from "@ailearn/shared/learning-objective-surface-contracts";

export const PROGRESS_SEGMENTS = ["还没答过", "练过了", "说清了"] as const;

/** 目标上的位置：只认服务端签发的那个 state。 */
const STATE_TO_SEGMENT: Record<ObjectivePersonalStateV3, number | null> = {
  unvalidated: 0,
  // 这一轮开始了还没结束、上次没达标——都算"动过手但还没说清"。
  learning: 1,
  needs_repair: 1,
  // 达标过一次之后就停不回来了：生疏与到复习都只是"那份证据在衰减"，
  // 精确的那句话由状态 chip 来说，这一段只报位置。
  stable: 2,
  fragile: 2,
  due_review: 2,
  scheduled: 2,
  // 原文变了 / 收起来了 / 被新卡替代：这条目标上没有正在走的位置。
  outdated: null,
  archived: null,
  superseded: null,
};

/** 结算页读的是这一轮的结论，不是目标的累计状态——两个轴不要混。 */
const OUTCOME_TO_SEGMENT: Record<string, number | null> = {
  demonstrated: 2,
  partial: 1,
  practice_completed: 1,
  needs_repair: 1,
  // 跳过与"暂时不会"没有把任何人往前推一步（DESIGN.md:152 同一口径）。
  skipped: null,
  declared_unable: null,
  not_assessable: null,
};

export function progressSegmentForState(state: string): number | null {
  return Object.hasOwn(STATE_TO_SEGMENT, state) ? STATE_TO_SEGMENT[state as ObjectivePersonalStateV3] : null;
}

export function progressSegmentForOutcome(outcome: string | null | undefined): number | null {
  if (!outcome) return null;
  return Object.hasOwn(OUTCOME_TO_SEGMENT, outcome) ? OUTCOME_TO_SEGMENT[outcome] : null;
}

/**
 * 读屏用的一句总结。界面上三段是并排的图形，没有顺序朗读就会变成"还没答过练过了
 * 说清了"三个词而已，听不出走到哪。
 */
export function progressBandLabel(segment: number | null): string {
  return segment === null
    ? "这条目标上还没有可报的位置"
    : `走到第 ${segment + 1} 段，共 3 段：${PROGRESS_SEGMENTS[segment]}`;
}
