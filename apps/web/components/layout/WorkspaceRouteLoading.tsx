import type { AppShellVariant } from "./AppShell";

const loadingCopy: Record<AppShellVariant, string> = {
  default: "正在打开学习空间…",
  focus: "正在展开学习内容…",
  internal: "正在载入评测工作台…",
};

/**
 * 路由级轻量占位。它只替换 AppShell 的 children，因此侧栏、平板顶栏和
 * 移动底栏会保持原位，不会在页面模块下载期间整屏闪白或发生布局跳变。
 */
export function WorkspaceRouteLoading({
  variant,
}: {
  variant: AppShellVariant;
}) {
  return (
    <section
      className={`workspace-route-loading workspace-route-loading--${variant}`}
      role="status"
      aria-live="polite"
      aria-busy="true"
      data-ui="workspace-route-loading"
    >
      <span className="workspace-route-loading__status">
        <i aria-hidden="true" />
        {loadingCopy[variant]}
      </span>

      <div className="workspace-route-loading__heading" aria-hidden="true">
        <span />
        <b />
        <small />
      </div>

      <div className="workspace-route-loading__grid" aria-hidden="true">
        <div className="workspace-route-loading__panel workspace-route-loading__panel--wide">
          <span />
          <b />
          <small />
          <small />
        </div>
        <div className="workspace-route-loading__panel">
          <span />
          <b />
          <small />
          <small />
        </div>
        <div className="workspace-route-loading__panel">
          <span />
          <b />
          <small />
          <small />
        </div>
      </div>

    </section>
  );
}
