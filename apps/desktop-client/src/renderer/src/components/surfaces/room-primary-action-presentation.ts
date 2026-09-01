import type { RoomPrimaryActionV1, RoomProjectionV1 } from "@ailearn/shared/room-projection-contracts";

type RoomPrimaryFocusData = Extract<RoomProjectionV1["primaryFocus"], { state: "data" }>["data"];

export function studyStatusLabel(objective: RoomPrimaryFocusData["objective"]): string {
  if (objective.personal.activeRun) return `进行中 · ${objective.personal.activeRun.phase}`;
  if (objective.personal.review?.status === "due") return "到期复习";
  if (objective.personal.initialValidation?.status === "ready") return "待首次验证";
  if (objective.personal.initialValidation?.status === "deferred") return "等待资格时间";
  if (objective.lifecycle.status === "blocked_content_upgrade") return "等待内容更新";
  if (objective.lifecycle.status === "superseded") return "已由后继目标替代";
  if (objective.lifecycle.status === "archived") return "已归档";
  if (objective.content.freshness === "source_outdated") return "来源需要刷新";
  return "服务端已确认";
}

export function studyActionLabel(action: RoomPrimaryActionV1["action"]): string {
  switch (action.kind) {
    case "create_run": return "开始首次验证";
    case "create_review_run": return "开始三分钟巩固";
    case "resume_run": return "继续三分钟旅程";
    case "practice_only": return "进入练习";
    case "wait_for_initial_validation": return "等待首次验证资格";
    case "view_successor": return "查看后继目标";
    case "refresh": return "重新读取目标";
    case "none": return "当前没有可执行行动";
  }
}

export function studyActionDescription(action: RoomPrimaryActionV1["action"]): string {
  switch (action.kind) {
    case "create_run": return action.goal;
    case "create_review_run": return "服务端已确认这个目标进入到期复习队列。";
    case "resume_run": return "恢复服务端已保存的学习进度。";
    case "practice_only": return "服务端要求先进行练习；桌面不会自行推断或修改目标状态。";
    case "wait_for_initial_validation": return `资格时间：${new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(action.qualificationNotBefore))}`;
    case "view_successor": return "当前目标已经被服务端标记为后继目标。";
    case "refresh": return "目标内容或来源发生变化，请重新读取服务端数据。";
    case "none": return "服务端当前没有提供可执行的主行动。";
  }
}

export function roomActionReasonLabel(action: RoomPrimaryActionV1): string | null {
  if (action.availability === "available") return null;
  const labels = {
    route_not_available: "当前窗口没有可用的学习运行入口。",
    capability_denied: "当前身份没有执行这个学习运行的权限。",
    feature_unavailable: "当前环境没有启用这个学习运行能力。",
    action_not_available: "服务端没有提供可执行的主行动。",
  } as const;
  return labels[action.reason];
}
