"use client";

import { Icon } from "@/components/ui/icons";

export type SessionKind = "review" | "validation";
export type SessionProgressPhase =
  | "loading"
  | "eligibility"
  | "question"
  | "evaluation";

interface ProgressCopy {
  eyebrow: string;
  title: string;
  detail: string;
  live: string;
}

interface SessionCopy {
  privacy: string;
  progressLabel: string;
  steps: Array<{ label: string; detail: string }>;
  phases: Record<SessionProgressPhase, ProgressCopy>;
}

const SESSION_COPY: Record<SessionKind, SessionCopy> = {
  review: {
    privacy: "复习开始前不会展示学习卡内容或答案线索。",
    progressLabel: "复习准备进度",
    steps: [
      { label: "定位到期任务", detail: "确认本轮复习边界" },
      { label: "建立回忆问题", detail: "保持答案线索隐藏" },
      { label: "校准理解结果", detail: "逐项判断独立回忆" },
    ],
    phases: {
      loading: {
        eyebrow: "间隔复习 · 取回记忆",
        title: "正在把这轮复习带到桌面",
        detail: "先读取到期任务与中性元数据，学习卡内容仍保持隐藏。",
        live: "正在定位这条到期任务",
      },
      eligibility: {
        eyebrow: "间隔复习 · 独立回忆",
        title: "先确认这轮回忆可以独立开始",
        detail: "检查到期时间、冷却状态与可信依据，不会提前展示答案线索。",
        live: "正在检查独立作答条件",
      },
      question: {
        eyebrow: "间隔复习 · 建立问题",
        title: "正在为这轮回忆准备一个问题",
        detail: "问题只取自你已经确认的学习材料，原文会继续保持隐藏。",
        live: "正在建立不带提示的回忆入口",
      },
      evaluation: {
        eyebrow: "间隔复习 · 校准理解",
        title: "正在校准这次独立回忆",
        detail: "系统会逐项判断回答是否覆盖关键理解，准备好后再由你揭示结果。",
        live: "回答已封存，正在逐项判断",
      },
    },
  },
  validation: {
    privacy: "作答前只显示问题，不会提前展示结论与原文。",
    progressLabel: "学习卡验证准备进度",
    steps: [
      { label: "锁定理解要点", detail: "确认版本与学习依据" },
      { label: "形成独立问题", detail: "只保留必要的提问" },
      { label: "对齐回答依据", detail: "核对覆盖与理解偏差" },
    ],
    phases: {
      loading: {
        eyebrow: "学习卡 · 独立验证",
        title: "正在建立本轮验证边界",
        detail: "只读取开始验证所需的中性信息，学习卡内容仍保持隐藏。",
        live: "正在载入验证所需信息",
      },
      eligibility: {
        eyebrow: "学习卡 · 独立验证",
        title: "先把学习卡折成一道问题",
        detail: "确认理解要点、学习依据与版本一致，再进入不带提示的独立作答。",
        live: "正在锁定本轮验证边界",
      },
      question: {
        eyebrow: "学习卡 · 提炼问题",
        title: "正在从学习卡里提炼一道好问题",
        detail: "题目围绕一个理解要点生成，不会把结论或原文提前带进来。",
        live: "正在形成清晰、可作答的问题",
      },
      evaluation: {
        eyebrow: "学习卡 · 对齐依据",
        title: "正在把回答与学习依据逐项对齐",
        detail: "回答已经安全保存，系统只在后台核对覆盖度与理解偏差。",
        live: "回答已封存，正在核对学习依据",
      },
    },
  },
};

const ACTIVE_STEP: Record<SessionProgressPhase, number> = {
  loading: 0,
  eligibility: 0,
  question: 1,
  evaluation: 2,
};

export function SessionProgressStage({
  sessionKind,
  stage,
}: {
  sessionKind: SessionKind;
  stage: SessionProgressPhase;
}) {
  const content = SESSION_COPY[sessionKind];
  const phase = content.phases[stage];
  const activeStep = ACTIVE_STEP[stage];
  const titleId = `session-progress-${sessionKind}-${stage}-title`;

  return (
    <section
      className="session-progress-stage"
      data-kind={sessionKind}
      data-stage={stage}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-busy="true"
      aria-labelledby={titleId}
    >
      <span className="session-progress-stage-kicker">
        <i aria-hidden="true" />
        {phase.eyebrow}
      </span>

      {sessionKind === "review" ? <ReviewProgressVisual /> : <ValidationProgressVisual />}

      <div className="session-progress-stage-copy">
        <h1 id={titleId}>{phase.title}</h1>
        <p>{phase.detail}</p>
      </div>

      <ol className="session-progress-stage-steps" aria-label={content.progressLabel}>
        {content.steps.map((step, index) => {
          const state = index < activeStep ? "complete" : index === activeStep ? "active" : "upcoming";

          return (
            <li
              key={step.label}
              data-state={state}
              aria-current={state === "active" ? "step" : undefined}
              aria-label={`${step.label}，${state === "complete" ? "已完成" : state === "active" ? "进行中" : "待进行"}`}
            >
              <span className="session-progress-stage-step-index" aria-hidden="true">
                {state === "complete" ? <Icon.Check /> : index + 1}
              </span>
              <span className="session-progress-stage-step-copy">
                <strong>{step.label}</strong>
                <small>{step.detail}</small>
              </span>
            </li>
          );
        })}
      </ol>

      <div className="session-progress-stage-live">
        <i aria-hidden="true" />
        <span>{phase.live}</span>
      </div>

      <p className="session-progress-stage-privacy">
        <Icon.Lock aria-hidden="true" />
        <span>{content.privacy}</span>
      </p>
    </section>
  );
}

function ReviewProgressVisual() {
  return (
    <div className="session-progress-stage-visual session-progress-stage-visual--review" aria-hidden="true">
      <span className="session-progress-memory-ring session-progress-memory-ring--outer" />
      <span className="session-progress-memory-ring session-progress-memory-ring--middle" />
      <span className="session-progress-memory-ring session-progress-memory-ring--inner" />
      <span className="session-progress-memory-slip session-progress-memory-slip--left">
        <i />
        <i />
      </span>
      <span className="session-progress-memory-slip session-progress-memory-slip--right">
        <i />
        <i />
      </span>
      <span className="session-progress-memory-core">
        <Icon.Review />
      </span>
      <span className="session-progress-memory-orbit-dot" />
    </div>
  );
}

function ValidationProgressVisual() {
  return (
    <div className="session-progress-stage-visual session-progress-stage-visual--validation" aria-hidden="true">
      <span className="session-progress-card-halo" />
      <span className="session-progress-card-sheet session-progress-card-sheet--back" />
      <span className="session-progress-card-sheet session-progress-card-sheet--middle" />
      <span className="session-progress-card-sheet session-progress-card-sheet--front">
        <span className="session-progress-card-mark">
          <Icon.Target />
        </span>
        <i />
        <i />
        <i />
        <span className="session-progress-card-scan" />
      </span>
      <span className="session-progress-card-spark session-progress-card-spark--top" />
      <span className="session-progress-card-spark session-progress-card-spark--bottom" />
    </div>
  );
}
