"use client";

/**
 * 任务 07-1：首次设置邀请（§5.4.3 / §3.2）。
 *
 * 注册成功并首次进入系统时，伴星只发出一次账号级设置邀请；这是用户尚未选择
 * 存在感前唯一一次可主动展示的 consent surface。
 *
 * 冻结语义（§5.4.3）：
 * - 固定三个**同级**动作：带我走一遍 / 我自己看看 / 先调整方式；
 * - "我自己看看" = **直接跳过**：不使用弱化颜色、倒计时、二次挽留或推荐角标；
 * - 不自动聚焦、非模态（不阻塞页面主内容）、无动画；
 * - 已有 quiet / temporary hidden / global off 偏好时**不渲染本组件**
 *   （由接线者依据 `deriveOnboardingView` 决策，本组件不做任何读取）；
 * - 纯 UI + props 回调，不调用服务端、不读取凭据、不发起任何模型/预取调用。
 *
 * 组件是纯展示层：onStart / onSkip / onAdjustMode 的具体行为（CAS transition、
 * 导航、偏好设置）由宿主页面接线注入，本组件零副作用。
 */

import type { ReactNode } from "react";

export interface OnboardingInviteProps {
  /** 带我走一遍（接线者应先做 02-3 CAS start 取得一次性 display permit）。 */
  onStart: () => void;
  /** 我自己看看（直接跳过：接线者调用 CAS skip，不弱化、不二次挽留）。 */
  onSkip: () => void;
  /** 先调整方式（接线者进入存在感设置/相处方式调整）。 */
  onAdjustMode: () => void;
  /** 覆盖卡片外层定位（默认在页面内容区顶部以内嵌卡片呈现）。 */
  className?: string;
}

/** 静态中性小立绘（复用安静锚点同款星际导航员头像的简化版，无动画）。 */
function InvitePortrait() {
  return (
    <svg
      width="40"
      height="40"
      viewBox="0 0 28 28"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className="block"
    >
      <path d="M4 21c4 2 8 1.5 10 2.5s6 0 10-2.5" opacity="0.55" />
      <circle cx="14" cy="11.5" r="6.5" />
      <path d="M11 11l1.4 1.4M15.6 12.4 17 11" />
      <path d="M12 15.5h4" />
      <path
        d="M14 6.4l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"
        fill="currentColor"
        stroke="none"
      />
    </svg>
  );
}

function InviteAction({
  children,
  onClick,
}: {
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex min-h-11 flex-1 items-center justify-center rounded-md border border-border bg-surface px-4 py-2.5 text-sm font-medium text-ink transition-colors hover:bg-surface-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-action"
    >
      {children}
    </button>
  );
}

export function OnboardingInvite({
  onStart,
  onSkip,
  onAdjustMode,
  className,
}: OnboardingInviteProps) {
  return (
    <section
      role="region"
      aria-label="首次设置邀请"
      data-ui="lc-onboarding-invite"
      className={
        className ??
        "rounded-card border border-border bg-surface p-5 shadow-sm"
      }
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-full bg-surface-soft text-ink">
          <InvitePortrait />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-medium text-ink">
            欢迎来到你的理解宇宙。
          </h2>
          <p className="mt-1 text-sm text-muted">
            要不要用大约 3 分钟和我走一遍？
          </p>
        </div>
      </div>

      <div className="mt-4 flex flex-col gap-2 sm:flex-row">
        <InviteAction onClick={onStart}>带我走一遍</InviteAction>
        <InviteAction onClick={onSkip}>我自己看看</InviteAction>
        <InviteAction onClick={onAdjustMode}>先调整方式</InviteAction>
      </div>

      <p className="mt-3 text-xs text-muted">
        之后也可以随时在设置或帮助中重新播放首次引导。
      </p>
    </section>
  );
}
