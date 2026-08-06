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

      <style>{`
        .workspace-route-loading {
          --workspace-route-loading-gutter: clamp(28px, 4vw, 64px);

          box-sizing: border-box;
          width: 100%;
          min-height: 100dvh;
          padding:
            var(--workspace-route-loading-gutter)
            max(var(--workspace-route-loading-gutter), var(--window-titlebar-safe-right))
            var(--workspace-route-loading-gutter)
            max(var(--workspace-route-loading-gutter), var(--window-titlebar-safe-left));
          color: var(--color-text-secondary);
        }
        .workspace:has(> .workspace-route-loading) {
          padding-bottom: 0;
        }
        .workspace-route-loading--focus {
          min-height: 100dvh;
          padding-top: clamp(72px, 9vw, 112px);
        }
        .workspace-route-loading__status {
          display: inline-flex;
          align-items: center;
          gap: 9px;
          min-height: 28px;
          font: 600 13px/1.2 var(--font-ui);
          letter-spacing: .04em;
          color: var(--color-text-tertiary);
        }
        .workspace-route-loading__status i {
          width: 8px;
          height: 8px;
          border-radius: var(--radius-pill);
          background: var(--color-highlight);
          box-shadow: 0 0 0 5px var(--color-highlight-soft);
        }
        .workspace-route-loading__heading {
          display: grid;
          gap: 12px;
          max-width: 680px;
          margin: 34px 0 40px;
        }
        .workspace-route-loading__heading span,
        .workspace-route-loading__heading b,
        .workspace-route-loading__heading small,
        .workspace-route-loading__panel > * {
          display: block;
          border-radius: var(--radius-pill);
          background: color-mix(in srgb, var(--color-border) 64%, var(--color-surface));
          animation: workspace-route-loading-pulse 1.25s var(--ease-standard) infinite alternate;
        }
        .workspace-route-loading__heading span { width: 126px; height: 11px; }
        .workspace-route-loading__heading b { width: min(78%, 420px); height: 38px; }
        .workspace-route-loading__heading small { width: min(92%, 590px); height: 15px; }
        .workspace-route-loading__grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr));
          gap: clamp(14px, 2vw, 22px);
        }
        .workspace-route-loading__panel {
          min-height: 190px;
          padding: clamp(20px, 2.4vw, 28px);
          border: 1px solid var(--color-border);
          border-radius: var(--radius-lg);
          background: var(--color-paper-muted);
          box-shadow: var(--shadow-control);
        }
        .workspace-route-loading__panel--wide {
          grid-column: span 2;
        }
        .workspace-route-loading__panel span { width: 72px; height: 10px; }
        .workspace-route-loading__panel b { width: 62%; height: 22px; margin-top: 24px; }
        .workspace-route-loading__panel small { width: 92%; height: 11px; margin-top: 18px; }
        .workspace-route-loading__panel small:last-child { width: 68%; margin-top: 10px; }
        @keyframes workspace-route-loading-pulse {
          from { opacity: .52; }
          to { opacity: .9; }
        }
        @media (min-width: 640px) and (max-width: 959px) {
          .workspace-route-loading--default,
          .workspace-route-loading--internal {
            min-height: calc(100dvh - 60px);
          }
        }
        @media (max-width: 639px) {
          .workspace-route-loading {
            padding:
              26px
              max(20px, var(--window-titlebar-safe-right))
              calc(var(--safe-bottom) + 28px)
              max(20px, var(--window-titlebar-safe-left));
          }
          .workspace-route-loading--default {
            min-height: calc(100dvh - var(--mobile-nav-inset));
            padding-bottom: calc(var(--mobile-nav-inset) + 24px);
          }
          .workspace-route-loading--focus,
          .workspace-route-loading--internal {
            min-height: 100dvh;
          }
          .workspace-route-loading--focus { padding-top: 76px; }
          .workspace-route-loading__heading { margin: 28px 0 30px; }
          .workspace-route-loading__panel--wide { grid-column: span 1; }
          .workspace-route-loading__panel { min-height: 154px; }
        }
        @media (prefers-reduced-motion: reduce) {
          .workspace-route-loading__heading span,
          .workspace-route-loading__heading b,
          .workspace-route-loading__heading small,
          .workspace-route-loading__panel > * { animation: none; }
        }
      `}</style>
    </section>
  );
}
