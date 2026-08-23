/**
 * Plan 23 FE-04：ObjectivePrimaryAction —— typed action exhaustive；
 * 不能由 label 文本决定跳转（§7.5/§29.1）。动作执行由调用方注入
 * （server action / 路由），本组件只负责呈现与语义。
 */
import type { JSX } from "react";
import type { LearningObjectivePrimaryActionV3 } from "@ailearn/shared";

/** typed action kind → 中文标签（唯一实现；页面复用，禁止由 label 反推跳转）。 */
export const OBJECTIVE_ACTION_LABELS: Record<LearningObjectivePrimaryActionV3["kind"], string> = {
  create_run: "开始验证",
  resume_run: "继续本次巩固",
  create_review_run: "开始复习",
  practice_only: "带着参考内容练一下",
  wait_for_initial_validation: "等待首次验证",
  view_successor: "查看新版目标",
  refresh: "刷新状态",
  none: "",
};

export function ObjectivePrimaryAction(props: {
  action: LearningObjectivePrimaryActionV3;
  onExecute: (action: LearningObjectivePrimaryActionV3) => void;
  disabled?: boolean;
  className?: string;
}): JSX.Element | null {
  const { action } = props;
  if (action.kind === "none") return null;
  const label = OBJECTIVE_ACTION_LABELS[action.kind];
  return (
    <button
      type="button"
      className={"objective-primary-action" + (props.className ? " " + props.className : "")}
      onClick={() => props.onExecute(action)}
      disabled={props.disabled}
      aria-label={label}
    >
      {label}
    </button>
  );
}
