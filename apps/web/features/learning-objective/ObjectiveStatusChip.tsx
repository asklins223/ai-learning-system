/**
 * Plan 23 FE-02：ObjectiveStatusChip —— 状态不只靠颜色（§36.2）。
 * ready / due / run / scheduled / outdated / archived。
 */
import type { JSX } from "react";

export type ObjectiveChipState =
  | "ready"
  | "due"
  | "run"
  | "scheduled"
  | "outdated"
  | "archived";

const LABELS: Record<ObjectiveChipState, string> = {
  ready: "等待首次验证",
  due: "到期复习",
  run: "学习中",
  scheduled: "已安排",
  outdated: "来源待更新",
  archived: "已归档",
};

export function ObjectiveStatusChip(props: {
  state: ObjectiveChipState;
  extra?: string;
  className?: string;
}): JSX.Element {
  const label = props.extra ?? LABELS[props.state];
  return (
    <span className={"objective-chip" + (props.className ? " " + props.className : "")} data-state={props.state}>
      <span aria-hidden="true">●</span>
      {label}
    </span>
  );
}
