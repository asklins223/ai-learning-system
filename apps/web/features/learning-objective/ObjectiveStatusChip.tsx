/**
 * Plan 23 FE-02：ObjectiveStatusChip —— 状态不只靠颜色（§36.2）。
 * ready / due / run / scheduled / outdated / stable / archived / superseded。
 *
 * §36.5 页面状态矩阵中 stable 是独立状态（有 canonical 学习记录），
 * 不能与 ready（等待首次验证）混为一谈——两者语义完全不同。
 */
import type { JSX } from "react";

export type ObjectiveChipState =
  | "ready"
  | "due"
  | "run"
  | "scheduled"
  | "outdated"
  | "stable"
  | "archived"
  | "superseded";

const LABELS: Record<ObjectiveChipState, string> = {
  ready: "等待首次验证",
  due: "到期复习",
  run: "学习中",
  scheduled: "已安排",
  outdated: "来源待更新",
  stable: "已稳定",
  archived: "已归档",
  superseded: "已由新版替代",
};

/** chip 状态 → 中文（供非 chip 场景复用同一份文案，如首页今日队列）。 */
export function objectiveChipStateLabel(state: ObjectiveChipState): string {
  return LABELS[state];
}

export function ObjectiveStatusChip(props: {
  state: ObjectiveChipState;
  extra?: string;
  className?: string;
}): JSX.Element {
  const label = props.extra ?? LABELS[props.state];
  return (
    <span className={"objective-chip" + (props.className ? " " + props.className : "")} data-state={props.state}>
      <span className="objective-chip-dot" aria-hidden="true" />
      {label}
    </span>
  );
}
