"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { Icon } from "@/components/ui/icons";

type OnboardingStepId =
  | "ai_consent"
  | "first_content"
  | "first_note"
  | "first_card"
  | "evidence_review"
  | "first_validation";

interface StepDef {
  id: OnboardingStepId;
  label: string;
  description: string;
  href: string;
  ctaLabel: string;
}

const ONBOARDING_STEPS: StepDef[] = [
  {
    id: "ai_consent",
    label: "确认 AI 使用边界",
    description: "仅在使用外部模型时，需要确认工作区的数据边界。",
    href: "/settings#model",
    ctaLabel: "查看模型设置",
  },
  {
    id: "first_content",
    label: "放入第一份材料",
    description: "粘贴原文、Markdown、代码或链接，系统会自动解析并整理。",
    href: "/#quick-capture",
    ctaLabel: "添加材料",
  },
  {
    id: "first_note",
    label: "生成第一篇笔记",
    description: "从已就绪的来源资料中创建笔记，提炼可引用的正文片段。",
    href: "/sources",
    ctaLabel: "查看来源",
  },
  {
    id: "first_card",
    label: "生成第一张学习卡",
    description: "从笔记中提取关键点，形成可以继续验证的学习卡。",
    href: "/notes",
    ctaLabel: "选择笔记",
  },
  {
    id: "evidence_review",
    label: "核对证据",
    description: "查看关键点引用的原文片段，确认结论有依据。",
    href: "/cards",
    ctaLabel: "核对学习卡",
  },
  {
    id: "first_validation",
    label: "完成首次验证",
    description: "回答一个验证问题，让系统据此安排后续复习。",
    href: "/cards",
    ctaLabel: "开始验证",
  },
];

interface OnboardingGuideProps {
  variant?: "default" | "starter";
}

export function OnboardingGuide({ variant = "default" }: OnboardingGuideProps) {
  const [state, setState] = useState<{
    steps: Record<string, boolean>;
    status: string;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const fetchedRef = useRef(false);

  const loadState = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.getOnboardingState();
      setState({ steps: result.steps, status: result.status });
      setLoadError(false);
    } catch {
      setState(null);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;
    void loadState();
  }, [loadState]);

  const effectiveSteps = useMemo(() => {
    const result: Record<string, boolean> = {};
    for (const step of ONBOARDING_STEPS) {
      result[step.id] = state?.steps[step.id] ?? false;
    }
    return result;
  }, [state]);

  if (loading) {
    return (
      <section
        className="onboarding-guide onboarding-guide--loading"
        data-guide-state="loading"
        data-variant={variant}
        aria-label="正在读取学习路径"
        aria-busy="true"
      >
        <span className="onboarding-guide-loading-mark" aria-hidden="true" />
        <span className="onboarding-guide-loading-line" aria-hidden="true" />
        <span className="onboarding-guide-loading-action" aria-hidden="true" />
      </section>
    );
  }

  if (loadError) {
    return (
      <section
        className="onboarding-guide onboarding-guide--error"
        data-guide-state="error"
        data-variant={variant}
        role="status"
      >
        <span className="onboarding-guide-error-icon" aria-hidden="true">
          <Icon.Warn />
        </span>
        <div>
          <strong>学习路径暂时没有同步</strong>
          <p>其他学习内容仍可继续使用。</p>
        </div>
        <button type="button" onClick={() => void loadState()}>
          重新同步
        </button>
      </section>
    );
  }

  const completedCount = ONBOARDING_STEPS.filter(
    (step) => effectiveSteps[step.id],
  ).length;
  const totalCount = ONBOARDING_STEPS.length;
  const allComplete = completedCount === totalCount;
  const progressPercent = Math.round((completedCount / totalCount) * 100);
  const nextStep = ONBOARDING_STEPS.find((step) => !effectiveSteps[step.id]);
  const nextStepIndex = nextStep
    ? ONBOARDING_STEPS.findIndex((step) => step.id === nextStep.id)
    : -1;

  if (allComplete || state?.status === "completed" || !nextStep) return null;

  return (
    <section
      className="onboarding-guide"
      data-ui="onboarding-guide"
      data-guide-state="active"
      data-variant={variant}
      data-first-run={completedCount === 0 ? "true" : "false"}
      data-next-step={nextStep.id}
      aria-labelledby="onboarding-guide-title"
    >
      <header className="onboarding-guide-header">
        <div className="onboarding-guide-title-group">
          <span className="onboarding-guide-symbol" aria-hidden="true">
            <Icon.Sparkle />
          </span>
          <div>
            <h2 id="onboarding-guide-title">
              {variant === "starter" ? "上手进度" : "学习路径"}
            </h2>
            <p>
              {variant === "starter"
                ? "系统默认模型已就绪，添加材料即可开始"
                : "根据真实学习记录自动推进"}
            </p>
          </div>
        </div>

        <div className="onboarding-guide-header-actions">
          <span className="onboarding-guide-count" aria-hidden="true">
            <strong>{completedCount}</strong>
            <span>/ {totalCount} 已完成</span>
          </span>
          <button
            type="button"
            className="onboarding-guide-expand"
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
            aria-controls="onboarding-learning-route"
          >
            <span>{expanded ? "收起路径" : "查看路径"}</span>
            <Icon.Chevron aria-hidden="true" />
          </button>
        </div>
      </header>

      <div className="onboarding-guide-progress-row">
        <div
          className="onboarding-guide-progress"
          role="progressbar"
          aria-valuenow={completedCount}
          aria-valuemin={0}
          aria-valuemax={totalCount}
          aria-valuetext={`已完成 ${completedCount} 步，共 ${totalCount} 步`}
        >
          <span style={{ width: `${progressPercent}%` }} />
        </div>
        <span className="onboarding-guide-progress-copy">
          还差 {totalCount - completedCount} 步
        </span>
      </div>

      <div className="onboarding-guide-current">
        <span className="onboarding-guide-current-index" aria-hidden="true">
          <small>下一步</small>
          <strong>{String(nextStepIndex + 1).padStart(2, "0")}</strong>
        </span>
        <div className="onboarding-guide-current-copy">
          <p>{variant === "starter" ? "完成第一个学习动作" : "建议继续"}</p>
          <h3>{nextStep.label}</h3>
          <span>{nextStep.description}</span>
        </div>
        <Link href={nextStep.href} className="onboarding-guide-cta">
          <span>{nextStep.ctaLabel}</span>
          <Icon.Arrow aria-hidden="true" />
        </Link>
      </div>

      <div
        id="onboarding-learning-route"
        className="onboarding-guide-route-wrap"
        hidden={!expanded}
      >
        <ol className="onboarding-guide-route" aria-label="完整学习路径">
          {ONBOARDING_STEPS.map((step, index) => {
            const done = effectiveSteps[step.id];
            const current = step.id === nextStep.id;
            const statusLabel = done ? "已完成" : current ? "当前" : "待完成";

            return (
              <li
                key={step.id}
                className={done ? "is-done" : current ? "is-current" : ""}
                aria-current={current ? "step" : undefined}
              >
                <span className="onboarding-guide-route-node" aria-hidden="true">
                  {done ? <Icon.Check /> : index + 1}
                </span>
                <div>
                  <small>{statusLabel}</small>
                  <strong>{step.label}</strong>
                </div>
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}
