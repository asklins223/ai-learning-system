import type { LearningObjectivePrimaryActionV3 } from "@ailearn/shared/learning-objective-surface-contracts";
import { createCommandId, createRequestMeta, unwrapGatewayResult } from "../../app/desktop-client";

export type ObjectiveActionDeps = {
  readonly epochRef: { current: number | undefined };
  readonly setActiveObjectiveId: (id: string) => void;
  readonly setActiveRunId: (id: string) => void;
  /** 交给旅程界面（详情页与列表都是 `invoke("validate")`）。 */
  readonly openRunSurface: () => void;
  readonly reload: () => Promise<unknown> | unknown;
};

/**
 * 学习卡「主行动」的唯一执行处。
 *
 * 此前列表焦点卡与详情页各写一份：列表那颗按钮上印着服务端的动词
 * （「继续作答」「开始首次验证」），`onClick` 却只是把详情页打开
 * （31 号文档 P9）。同一个词在两个地方指向两个地方，用户按下去发现没开始，
 * 就只能怀疑产品是不是坏了。这里收成一个函数，两边都调它，动词与落点必然一致。
 *
 * 返回 true 表示已经交给旅程界面；false 表示这个 action 本身不起旅程
 * （refresh / view_successor / 等待类）。
 */
export async function startObjectiveJourney(
  action: LearningObjectivePrimaryActionV3,
  deps: ObjectiveActionDeps,
): Promise<boolean> {
  if (action.kind === "refresh") {
    await deps.reload();
    return false;
  }
  if (action.kind === "view_successor") {
    deps.setActiveObjectiveId(action.successorObjectiveId);
    return false;
  }
  if (action.kind === "resume_run") {
    deps.setActiveRunId(action.runId);
    deps.openRunSurface();
    return true;
  }
  if (action.kind !== "create_run" && action.kind !== "create_review_run" && action.kind !== "practice_only") {
    return false;
  }
  const commandLabel = action.kind === "create_review_run"
    ? "start-objective-review"
    : action.kind === "practice_only"
      ? "start-objective-practice"
      : "start-objective-run";
  const response = await window.ailearn.learningRun.start({
    meta: createRequestMeta(deps.epochRef.current),
    commandId: createCommandId(commandLabel),
    request: action.start,
  });
  if (response.workspaceEpoch) deps.epochRef.current = response.workspaceEpoch;
  const snapshot = unwrapGatewayResult(response);
  deps.setActiveRunId(snapshot.runId);
  deps.openRunSurface();
  return true;
}
