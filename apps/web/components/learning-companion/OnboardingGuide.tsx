"use client";

/**
 * 任务 07-1：六步首次引导 UI（§5.4.3 / §3.2）。
 *
 * 六步：认识边界 → 调整相处方式（默认安静）→ 选择起点（沙盒或自己的内容）
 * → 走过示例流程（onboarding_sample:*）→ 看见可信交接（publishedTargetEligibility=false）
 * → 明确结束（从我的内容开始 / 去星图看看 / 结束引导）。
 *
 * 冻结语义（§5.4.3）：
 * - 引导**零副作用**：本组件不调用 API、不触发 exposure/学习事实/调度、无计时器
 *   （无倒计时/无自动下一步）；所有动作经 props 回调由宿主页面接线；
 * - 结束动作是用户显式三选一，引导不会自动开始正式航程；
 * - 完成或跳过后不再自动邀请或重放，可随时从设置/帮助手动重新开始（由接线者处理）；
 * - 步进导航是本地 UI 状态（onGoToStep），不写服务端；服务端只管理 run 生命周期；
 * - 非模态、不自动聚焦、reduced-motion 友好（无动画）。
 *
 * 组件是纯展示层：onSetCompanionship / onSetStartingPoint / onFinish / onExit /
 * onGoToStep 的具体行为（CAS transition、账号偏好、导航）由宿主页面注入。
 */

import { Icon } from "@/components/ui/icons";
import {
  ONBOARDING_SAMPLE_PUBLISHED_TARGET_ELIGIBILITY,
  ONBOARDING_SAMPLE_TITLE,
  ONBOARDING_STEPS,
  type OnboardingCompanionshipMode,
  type OnboardingFinishAction,
  type OnboardingStartingPoint,
  type OnboardingStepId,
} from "@/lib/learning-companion/onboarding-state";

export interface OnboardingGuideProps {
  /** 当前引导步骤（由接线者持有本地 step 状态）。 */
  step: OnboardingStepId;
  /** 当前相处方式档位（默认安静）。 */
  companionshipMode: OnboardingCompanionshipMode;
  /** 已选起点（null = 尚未选择）。 */
  startingPoint: OnboardingStartingPoint | null;
  /** 选择相处方式（三档，quiet/moderate/active）。 */
  onSetCompanionship: (mode: OnboardingCompanionshipMode) => void;
  /** 选择起点（沙盒 / 自己的内容）。 */
  onSetStartingPoint: (point: OnboardingStartingPoint) => void;
  /** 手动跳转步骤（本地 UI 导航，不写服务端）。 */
  onGoToStep: (step: OnboardingStepId) => void;
  /** 明确结束的三个同级动作（用户显式三选一，不自动开始正式航程）。 */
  onFinish: (action: OnboardingFinishAction) => void;
  /** 结束引导（pause 当前 run，之后可被动续接）。 */
  onExit: () => void;
  /** 覆盖外层定位类。 */
  className?: string;
}

// ─── 单选选择项 ──────────────────────────────────────────────────────────

function ChoiceOption({
  name,
  value,
  checked,
  label,
  description,
  onChange,
}: {
  name: string;
  value: string;
  checked: boolean;
  label: string;
  description: string;
  onChange: (value: string) => void;
}) {
  return (
    <label
      className={`flex cursor-pointer items-start gap-3 rounded-card border px-4 py-3 transition-colors focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-action ${
        checked ? "border-action bg-surface-soft" : "border-border bg-surface"
      }`}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={() => onChange(value)}
        className="mt-1 size-4 accent-action"
      />
      <span className="min-w-0">
        <strong className="block text-sm font-medium text-ink">{label}</strong>
        <small className="mt-0.5 block text-xs leading-relaxed text-muted">
          {description}
        </small>
      </span>
    </label>
  );
}

// ─── 六步内容 ────────────────────────────────────────────────────────────

function BoundariesContent() {
  return (
    <div className="space-y-3 text-sm leading-relaxed text-ink">
      <p className="text-muted">
        伴星是你的学习同行者：帮你理解材料、找到证据、安排复习。但有几条边界始终不变：
      </p>
      <ul className="list-disc space-y-1.5 pl-5 text-muted">
        <li>不读取你的密码与凭据；</li>
        <li>不替你完成正式验证，也不替你做任何事；</li>
        <li>不会未经确认就创建、修改或发布你的内容；</li>
        <li>不会自动开始正式航程。</li>
      </ul>
    </div>
  );
}

function CompanionshipContent({
  mode,
  onSetCompanionship,
}: {
  mode: OnboardingCompanionshipMode;
  onSetCompanionship: (mode: OnboardingCompanionshipMode) => void;
}) {
  const options: { value: OnboardingCompanionshipMode; label: string; description: string }[] = [
    {
      value: "quiet",
      label: "安静（默认）",
      description: "未召唤时只有静态锚点，不主动打扰；你有需要时召唤它。",
    },
    {
      value: "moderate",
      label: "适度陪伴",
      description: "只在重要时刻（如恢复暂停的任务、可恢复的错误）给一次提醒，未响应就退场。",
    },
    {
      value: "active",
      label: "主动建议",
      description: "在适度陪伴的基础上，多给一条有原因说明的下一步建议，但不自动开始。",
    },
  ];
  return (
    <fieldset>
      <legend className="sr-only">选择相处方式（未选择前默认安静）</legend>
      <div className="space-y-2">
        {options.map((option) => (
          <ChoiceOption
            key={option.value}
            name="onboarding-companionship"
            value={option.value}
            checked={mode === option.value}
            label={option.label}
            description={option.description}
            onChange={(value) => onSetCompanionship(value as OnboardingCompanionshipMode)}
          />
        ))}
      </div>
    </fieldset>
  );
}

function StartingPointContent({
  startingPoint,
  onSetStartingPoint,
}: {
  startingPoint: OnboardingStartingPoint | null;
  onSetStartingPoint: (point: OnboardingStartingPoint) => void;
}) {
  const options: { value: OnboardingStartingPoint; label: string; description: string }[] = [
    {
      value: "sandbox",
      label: "沙盒（内置示例）",
      description: "先用内置示例材料逛逛，不接触你的真实内容，也不会产生正式目标。",
    },
    {
      value: "own-content",
      label: "自己的内容",
      description: "直接进入你的材料，从你自己已经保存的内容开始。",
    },
  ];
  return (
    <fieldset>
      <legend className="sr-only">选择起点</legend>
      <div className="space-y-2">
        {options.map((option) => (
          <ChoiceOption
            key={option.value}
            name="onboarding-starting-point"
            value={option.value}
            checked={startingPoint === option.value}
            label={option.label}
            description={option.description}
            onChange={(value) => onSetStartingPoint(value as OnboardingStartingPoint)}
          />
        ))}
      </div>
      <p className="mt-3 text-xs text-muted">
        示例流程（onboarding_sample:*）不会产生正式目标；选择沙盒后随时可以切换回自己的内容。
      </p>
    </fieldset>
  );
}

function SampleFlowContent() {
  return (
    <div className="space-y-3">
      <article
        data-ui="onboarding-sample-card"
        className="rounded-card border border-border bg-surface p-4"
      >
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-muted">学习卡</span>
          <span className="rounded-full bg-surface-soft px-2 py-0.5 text-xs text-muted">
            内置示例
          </span>
        </div>
        <h3 className="mt-2 text-base font-medium text-ink">
          {ONBOARDING_SAMPLE_TITLE}
        </h3>
        <ul className="mt-2 space-y-1.5 text-sm text-muted">
          <li>关键点：理解宇宙由多个星域组成，每个星域有自己的材料与事实。</li>
          <li>关键点：每张学习卡都绑定明确的证据来源。</li>
          <li>关键点：只有通过可信验证的事实才会点亮理解。</li>
        </ul>
      </article>
      <p className="text-sm leading-relaxed text-muted">
        这是只读示例。走一遍就能了解一次学习回合长什么样：读卡、查看证据、决定下一步。
        它不会进入你的学习记录。
      </p>
    </div>
  );
}

function TrustedHandoffContent() {
  return (
    <div className="space-y-3 text-sm leading-relaxed text-muted">
      <p>
        示例中的内容标记为 <code className="rounded bg-surface-soft px-1 py-0.5 text-xs">publishedTargetEligibility={"false"}</code>
        ，也就是 <strong className="text-ink">不是正式发布目标</strong>：
        它只用来练习，不能产生正式验证结果。
      </p>
      <p>
        正式航程会在开始前清晰标注资格与信任边界：你始终知道哪些是已发布的事实、
        哪些只是练习，以及一次航程会带来什么。
      </p>
      <p className="text-xs">
        {ONBOARDING_SAMPLE_PUBLISHED_TARGET_ELIGIBILITY === false
          ? "当前示例的 published target eligibility：false（只读练习，不可正式验证）"
          : null}
      </p>
    </div>
  );
}

function FinishContent({ onFinish }: { onFinish: (action: OnboardingFinishAction) => void }) {
  const actions: {
    action: OnboardingFinishAction;
    label: string;
    description: string;
  }[] = [
    {
      action: "start-own-content",
      label: "从我的内容开始",
      description: "进入你的材料，正式航程由你明确发起。",
    },
    {
      action: "go-to-star-map",
      label: "去星图看看",
      description: "打开理解星图，浏览你的知识宇宙。",
    },
    {
      action: "end-guide",
      label: "结束引导",
      description: "先结束引导，之后随时可以从设置或帮助重新播放。",
    },
  ];
  return (
    <div className="space-y-3">
      <p className="text-sm leading-relaxed text-muted">
        引导到此结束。它不会自动开始正式航程——下一步由你决定：
      </p>
      <div className="space-y-2">
        {actions.map(({ action, label, description }) => (
          <button
            key={action}
            type="button"
            onClick={() => onFinish(action)}
            className="flex min-h-11 w-full items-center justify-between gap-3 rounded-card border border-border bg-surface px-4 py-3 text-left transition-colors hover:bg-surface-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-action"
          >
            <span>
              <strong className="block text-sm font-medium text-ink">{label}</strong>
              <small className="mt-0.5 block text-xs text-muted">{description}</small>
            </span>
            <Icon.Chevron aria-hidden="true" className="size-4 shrink-0 text-muted" />
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── 引导主组件 ──────────────────────────────────────────────────────────

export function OnboardingGuide({
  step,
  companionshipMode,
  startingPoint,
  onSetCompanionship,
  onSetStartingPoint,
  onGoToStep,
  onFinish,
  onExit,
  className,
}: OnboardingGuideProps) {
  const meta = ONBOARDING_STEPS.find((item) => item.id === step) ?? ONBOARDING_STEPS[0];
  const isFinish = step === "finish";
  const stepIndex = ONBOARDING_STEPS.findIndex((item) => item.id === step);

  function renderStepContent() {
    switch (step) {
      case "boundaries":
        return <BoundariesContent />;
      case "companionship":
        return <CompanionshipContent mode={companionshipMode} onSetCompanionship={onSetCompanionship} />;
      case "starting-point":
        return <StartingPointContent startingPoint={startingPoint} onSetStartingPoint={onSetStartingPoint} />;
      case "sample-flow":
        return <SampleFlowContent />;
      case "trusted-handoff":
        return <TrustedHandoffContent />;
      case "finish":
        return <FinishContent onFinish={onFinish} />;
    }
  }

  return (
    <section
      role="region"
      aria-label="首次引导"
      aria-live="polite"
      data-ui="lc-onboarding-guide"
      className={
        className ??
        "rounded-card border border-border bg-surface p-5 shadow-sm sm:p-6"
      }
    >
      <header className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-ink">
          <Icon.Compass aria-hidden="true" className="size-5" />
          <h2 className="text-base font-medium">和伴星走一遍首次引导</h2>
        </div>
        <button
          type="button"
          onClick={onExit}
          aria-label="结束引导（之后可随时重新播放）"
          className="inline-flex min-h-10 items-center gap-1 rounded-md px-2.5 text-sm text-muted transition-colors hover:bg-surface-soft hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-action"
        >
          <Icon.X aria-hidden="true" className="size-4" />
          <span className="hidden sm:inline">结束引导</span>
        </button>
      </header>

      {/* 步骤指示（六点，可手动跳转） */}
      <nav aria-label="引导步骤" className="mt-4">
        <ol className="flex items-center gap-1.5">
          {ONBOARDING_STEPS.map((item) => {
            const active = item.id === step;
            return (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => onGoToStep(item.id)}
                  aria-current={active ? "step" : undefined}
                  aria-label={`第 ${item.index} 步：${item.title}`}
                  className={`inline-flex size-8 items-center justify-center rounded-full text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-action ${
                    active
                      ? "bg-action text-on-action"
                      : "bg-surface-soft text-muted hover:bg-border hover:text-ink"
                  }`}
                >
                  {item.index}
                </button>
              </li>
            );
          })}
        </ol>
      </nav>

      {/* 步骤内容 */}
      <div className="mt-5">
        <h3 className="text-lg font-medium text-ink">{meta.heading}</h3>
        <p className="mt-1 text-sm leading-relaxed text-muted">{meta.description}</p>
        <div className="mt-4">{renderStepContent()}</div>
      </div>

      {/* 底部导航：前五步上一步/下一步；finish 步由内容区三个同级结束动作收束 */}
      {!isFinish && (
        <footer className="mt-6 flex items-center justify-between gap-2 border-t border-border pt-4">
          <button
            type="button"
            onClick={() => {
              const previous = ONBOARDING_STEPS[stepIndex - 1];
              if (previous) onGoToStep(previous.id);
            }}
            disabled={stepIndex <= 0}
            className="inline-flex min-h-10 items-center gap-1 rounded-md px-3 text-sm text-muted transition-colors hover:bg-surface-soft hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-action disabled:pointer-events-none disabled:opacity-40"
          >
            <Icon.Chevron aria-hidden="true" className="size-4 rotate-90" />
            上一步
          </button>
          <button
            type="button"
            onClick={() => {
              const next = ONBOARDING_STEPS[stepIndex + 1];
              if (next) onGoToStep(next.id);
            }}
            className="inline-flex min-h-10 items-center gap-1 rounded-md border border-border bg-surface px-4 text-sm font-medium text-ink transition-colors hover:bg-surface-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-action"
          >
            下一步
            <Icon.Chevron aria-hidden="true" className="size-4 -rotate-90" />
          </button>
        </footer>
      )}
    </section>
  );
}
