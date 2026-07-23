"use client";

import { Icon } from "@/components/ui/icons";

type MemberNoticeVariant = "inline" | "badge";
type MemberNoticeContext = "workspace" | "note";

interface MemberNoticeProps {
  variant?: MemberNoticeVariant;
  context?: MemberNoticeContext;
}

/**
 * RBAC: 成员只读提示。
 *
 * inline 用于内容语境说明，badge 用于标题栏或元信息区域。
 * 这是静态权限信息，不使用 live region，避免每次页面挂载都被播报成动态状态。
 */
export function MemberNotice({
  variant = "inline",
  context = "workspace",
}: MemberNoticeProps) {
  if (variant === "badge") {
    return (
      <span className="member-notice--badge" role="note" aria-label="成员只读访问">
        <Icon.Lock aria-hidden="true" />
        成员只读
      </span>
    );
  }

  const isNote = context === "note";

  return (
    <div
      className={`member-notice${isNote ? " member-notice--note" : ""}`}
      role="note"
      aria-label={isNote ? "共享笔记只读访问说明" : "成员只读访问说明"}
    >
      <span className="member-notice-icon" aria-hidden="true">
        <Icon.Lock />
      </span>
      <div className="member-notice-body">
        <span className="member-notice-eyebrow">
          {isNote ? "共享笔记 · 只读" : "成员访问"}
        </span>
        <strong>{isNote ? "你正在以成员身份查看" : "当前为成员只读访问"}</strong>
        <p>
          {isNote
            ? "内容修改与学习卡生成由工作区所有者完成；如需调整，请联系所有者。"
            : "内容管理由工作区所有者完成，你仍可以查看、验证和复习。"}
        </p>
        {isNote && (
          <p className="member-notice-available">
            <span>仍可继续</span>
            阅读内容 · 查看已有学习卡 · 验证与复习
          </p>
        )}
      </div>
    </div>
  );
}
