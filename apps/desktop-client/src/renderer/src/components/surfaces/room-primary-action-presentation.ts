import type { RoomPrimaryActionV1, RoomProjectionV1 } from "@ailearn/shared/room-projection-contracts";
import {
  formatObjectiveState,
  primaryActionDescription,
  primaryActionLabel,
} from "./objective-state-copy";

type RoomPrimaryFocusData = Extract<RoomProjectionV1["primaryFocus"], { state: "data" }>["data"];

/**
 * The objective surface types `activeRun.phase` as a free string, but the server
 * only ever writes the `LearningRunPhase` vocabulary. Translate the tokens we
 * know and return `null` for everything else, so a phase we cannot name reads as
 * the plain "进行中" instead of leaking a raw server token (`进行中 · active`)
 * into Chinese copy.
 */
export function runPhaseLabel(phase: string): string | null {
  switch (phase) {
    case "preparing": return "准备中";
    case "active": return "进行中";
    case "assessing": return "判定中";
    case "checkpoint": return "等待确认";
    case "committing": return "写入中";
    case "paused": return "已暂停";
    case "completed": return "已完成";
    case "ended": return "已结束";
    case "skipped": return "已跳过";
    case "cancelled": return "已取消";
    case "stale": return "已过期";
    case "recoverable_error": return "需要恢复";
    default: return null;
  }
}

/**
 * 状态词只有一个来源：服务端签发的 `personalState.state`。合同里写着
 * "列表、详情、RoomProjection 必须直接展示该值，不得在各客户端按各自优先级
 * 重新推导"，而这里此前自己按 activeRun/review/initialValidation 推了一套
 * 「待首次验证 / 等待资格时间 / 服务端已确认」——同一个目标在房间页和列表页
 * 说的是两句话（2026-09-20 实走复盘 #9）。
 */
export function studyStatusLabel(objective: RoomPrimaryFocusData["objective"]): string {
  const label = formatObjectiveState(objective.personalState.state);
  const phase = objective.personal.activeRun ? runPhaseLabel(objective.personal.activeRun.phase) : null;
  return phase && phase !== "进行中" ? `${label} · ${phase}` : label;
}

export function studyActionLabel(action: RoomPrimaryActionV1["action"]): string {
  return primaryActionLabel(action);
}

export function studyActionDescription(action: RoomPrimaryActionV1["action"]): string {
  return primaryActionDescription(action);
}

export function roomActionReasonLabel(action: RoomPrimaryActionV1): string | null {
  if (action.availability === "available") return null;
  const labels = {
    route_not_available: "当前窗口没有可用的学习运行入口。",
    capability_denied: "当前身份没有执行这个学习运行的权限。",
    feature_unavailable: "当前环境没有启用这个学习运行能力。",
    action_not_available: "这一轮没有可执行的动作。",
  } as const;
  return labels[action.reason];
}
