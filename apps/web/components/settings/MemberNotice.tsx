"use client";

import { Icon } from "@/components/ui/icons";

/**
 * RBAC: 成员只读提示。
 *
 * 完整横幅用于页面顶部，紧凑药丸用于工具栏内联。
 * 视觉对齐 .ne-notice / .settings-notice 模式：
 * 简单边框 + evidence-soft 背景，无阴影无装饰。
 */
export function MemberNotice({ compact = false }: { compact?: boolean }) {
  if (compact) {
    return (
      <span className="member-notice--compact" role="status">
        <Icon.Eye aria-hidden="true" />
        成员模式 · 只读
      </span>
    );
  }

  return (
    <div className="member-notice" role="status">
      <span className="member-notice-icon" aria-hidden="true">
        <Icon.Eye />
      </span>
      <div className="member-notice-body">
        <strong>成员模式 · 只读访问</strong>
        <p>可查看、验证和复习，编辑操作需所有者权限。</p>
      </div>
    </div>
  );
}
