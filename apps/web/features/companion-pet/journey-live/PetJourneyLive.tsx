"use client";

/**
 * Journey V2 桌宠首邀与旅程推进 UI（文档 16 §8.1/§10.1）。
 *
 * 只在 Electron Pet 窗口启用（桌宠默认不做 web 端）。UI 保持克制：
 * 角色旁一张小卡片，不抢焦点、不自动导航；"稍后"只延期、"跳过讲解"
 * 只隐藏叙事，都不伪造业务里程碑。
 */

import { useEffect, useState } from "react";
import type { AllowedMainRouteV2 } from "@ailearn/shared";
import type { CompanionJourneyV2 } from "@ailearn/shared";
import { useJourneyLive } from "./useJourneyLive";
import "./pet-journey-live.css";

export interface PetJourneyLiveProps {
  enabled: boolean;
  workspaceId?: string;
  /** 打开主窗口路由（Bridge V2 open_route；浏览器路径不渲染本组件）。 */
  onNavigate?: (route: AllowedMainRouteV2) => void;
  /** 卡片实际可见时回调（用于与 delivery 气泡互斥，§10.2 同一时刻一个 cue）。 */
  onVisibleChange?: (visible: boolean) => void;
}

type JourneyBranch = "own_material" | "sandbox_sample" | "blank_note";

const BRANCH_LABEL: Record<JourneyBranch, string> = {
  own_material: "用我的资料走一遍",
  sandbox_sample: "体验 90 秒示例",
  blank_note: "从一张空白笔记开始",
};

export function PetJourneyLive({ enabled, workspaceId, onNavigate, onVisibleChange }: PetJourneyLiveProps) {
  const journey = useJourneyLive(enabled && Boolean(workspaceId), workspaceId);
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (key: string, action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(key);
    try {
      await action();
    } finally {
      setBusy(null);
    }
  };

  const invitation = journey.invitation;
  const showInvitation = invitation !== null
    && (invitation.status === "not_offered" || invitation.status === "offered");
  const deferredActive = invitation !== null
    && invitation.status === "deferred"
    && invitation.deferredUntil !== null
    && new Date(invitation.deferredUntil).getTime() > Date.now();
  const current = journey.journey;
  const journeyActive = current !== null
    && current.status !== "completed" && current.status !== "skipped";
  const visible = enabled && Boolean(workspaceId)
    && (journey.status === "error" || showInvitation || (!deferredActive && journeyActive));

  useEffect(() => {
    onVisibleChange?.(visible);
  }, [visible, onVisibleChange]);

  if (!visible) return null;
  if (journey.status === "idle" || journey.status === "loading") return null;

  if (journey.status === "error") {
    return (
      <div className="pet-journey-live-card" role="status">
        <p className="pet-journey-live-title">旅程状态暂时不可用</p>
        <button
          type="button"
          className="pet-journey-live-action"
          onClick={() => void run("refresh", journey.refresh)}
          disabled={busy !== null}
        >
          重试
        </button>
      </div>
    );
  }

  if (showInvitation) {
    return (
      <div className="pet-journey-live-card pet-journey-live-invitation" role="dialog" aria-label="首次邀请">
        <p className="pet-journey-live-title">嗨，我是你的学习伴星。</p>
        <p className="pet-journey-live-body">
          我会在你需要时，把资料变成一次次三分钟内能完成的小行动。想从哪里开始？
        </p>
        <div className="pet-journey-live-choices">
          {(["own_material", "sandbox_sample", "blank_note"] as JourneyBranch[]).map((branch) => (
            <button
              key={branch}
              type="button"
              className="pet-journey-live-action"
              disabled={busy !== null}
              onClick={() => void run(`start:${branch}`, () => journey.startJourney(branch))}
            >
              {BRANCH_LABEL[branch]}
            </button>
          ))}
        </div>
        <div className="pet-journey-live-footer">
          <button
            type="button"
            className="pet-journey-live-link"
            disabled={busy !== null}
            onClick={() => void run("defer", journey.deferInvitation)}
          >
            稍后再问我
          </button>
          <button
            type="button"
            className="pet-journey-live-link"
            disabled={busy !== null}
            onClick={() => void run("skip-invitation", journey.skipInvitation)}
          >
            我先自己看看
          </button>
        </div>
      </div>
    );
  }

  if (deferredActive) return null;

  const currentJourney = journey.journey;
  if (!currentJourney || currentJourney.status === "completed" || currentJourney.status === "skipped") return null;

  return <JourneyStepCard journey={currentJourney} busy={busy} run={run} onNavigate={onNavigate} journeyApi={journey} />;
}

function JourneyStepCard({
  journey,
  busy,
  run,
  onNavigate,
  journeyApi,
}: {
  journey: CompanionJourneyV2;
  busy: string | null;
  run: (key: string, action: () => Promise<unknown>) => Promise<void>;
  onNavigate?: (route: AllowedMainRouteV2) => void;
  journeyApi: ReturnType<typeof useJourneyLive>;
}) {
  const navigate = (route: AllowedMainRouteV2) => {
    onNavigate?.(route);
  };

  if (journey.status === "recoverable_error") {
    return (
      <div className="pet-journey-live-card" role="alert">
        <p className="pet-journey-live-title">引导遇到了一点问题</p>
        <p className="pet-journey-live-body">你可以重试，或先自己继续学习。</p>
        <div className="pet-journey-live-choices">
          <button
            type="button"
            className="pet-journey-live-action"
            disabled={busy !== null}
            onClick={() => void run("retry", journeyApi.retryJourney)}
          >
            重试引导
          </button>
          <button
            type="button"
            className="pet-journey-live-action"
            disabled={busy !== null}
            onClick={() => void run("skip-journey", journeyApi.skipJourney)}
          >
            跳过引导
          </button>
        </div>
      </div>
    );
  }

  if (journey.status === "paused") {
    return (
      <div className="pet-journey-live-card" role="status">
        <p className="pet-journey-live-title">引导已暂停</p>
        <p className="pet-journey-live-body">随时可以继续，进度已保存。</p>
        <button
          type="button"
          className="pet-journey-live-action"
          disabled={busy !== null}
          onClick={() => void run("resume", journeyApi.resumeJourney)}
        >
          继续引导
        </button>
      </div>
    );
  }

  const step = journey.currentStep;
  const refs = journey.refs ?? {};

  const stepContent = renderStepContent(step, refs, navigate);

  return (
    <div className="pet-journey-live-card" role="status">
      <p className="pet-journey-live-step">{stepLabel(step)}</p>
      {stepContent}
      <div className="pet-journey-live-footer">
        {step !== null && step !== "closing" && (
          <button
            type="button"
            className="pet-journey-live-link"
            disabled={busy !== null}
            onClick={() => void run("dismiss", () => journeyApi.dismissStepNarration(step))}
          >
            跳过这段讲解
          </button>
        )}
        <button
          type="button"
          className="pet-journey-live-link"
          disabled={busy !== null}
          onClick={() => void run("pause", journeyApi.pauseJourney)}
        >
          稍后继续
        </button>
        <button
          type="button"
          className="pet-journey-live-link"
          disabled={busy !== null}
          onClick={() => void run("skip-journey", journeyApi.skipJourney)}
        >
          跳过全部引导
        </button>
      </div>
    </div>
  );
}

function stepLabel(step: CompanionJourneyV2["currentStep"]): string {
  switch (step) {
    case "boundary_intro": return "第一次见面";
    case "preference_capture": return "相处偏好";
    case "goal_capture": return "当前目标";
    case "choose_start": return "选择起点";
    case "first_source": return "导入资料";
    case "source_processing": return "解析资料";
    case "first_note": return "整理笔记";
    case "first_card": return "生成学习卡";
    case "first_evidence": return "查看证据";
    case "first_run": return "第一次巩固";
    case "first_schedule": return "复习安排";
    case "sample_orientation": return "示例体验";
    case "closing": return "准备就绪";
    default: return "引导进行中";
  }
}

function renderStepContent(
  step: CompanionJourneyV2["currentStep"],
  refs: CompanionJourneyV2["refs"],
  navigate: (route: AllowedMainRouteV2) => void,
): React.ReactNode {
  switch (step) {
    case "boundary_intro":
      return <p className="pet-journey-live-body">正式作答时我会保持安静；不会替你判卷，也不会自动改你的复习安排。</p>;
    case "preference_capture":
    case "goal_capture":
      return <p className="pet-journey-live-body">这一步可以跳过，不回答也不会阻塞你的学习。</p>;
    case "choose_start":
      return <p className="pet-journey-live-body">选择一条路线开始：用自己的资料、空白笔记，或先体验示例。</p>;
    case "first_source":
      if (refs.sourceId) {
        return (
          <button type="button" className="pet-journey-live-action" onClick={() => navigate({ kind: "source", sourceId: refs.sourceId })}>
            打开资料
          </button>
        );
      }
      return <p className="pet-journey-live-body">在资料页导入或打开一份资料，我会接着引导你。</p>;
    case "source_processing":
      return <p className="pet-journey-live-body">资料正在解析，完成后我会告诉你。</p>;
    case "first_note":
      if (refs.noteId) {
        return (
          <button type="button" className="pet-journey-live-action" onClick={() => navigate({ kind: "note", noteId: refs.noteId! })}>
            打开笔记
          </button>
        );
      }
      return <p className="pet-journey-live-body">笔记准备好后，就可以生成学习卡。</p>;
    case "first_card":
      if (refs.cardId) {
        return (
          <button type="button" className="pet-journey-live-action" onClick={() => navigate({ kind: "card", cardId: refs.cardId! })}>
            打开学习卡
          </button>
        );
      }
      return <p className="pet-journey-live-body">学习卡正在生成，完成后可以开始第一次巩固。</p>;
    case "first_evidence":
      return <p className="pet-journey-live-body">打开卡片里的证据，可以确认每个要点都有来源。</p>;
    case "first_run":
      if (refs.runId) {
        return (
          <button type="button" className="pet-journey-live-action" onClick={() => navigate({ kind: "learning_run", runId: refs.runId! })}>
            继续学习
          </button>
        );
      }
      if (refs.cardId) {
        return (
          <button type="button" className="pet-journey-live-action" onClick={() => navigate({ kind: "card", cardId: refs.cardId! })}>
            用三分钟巩固一下
          </button>
        );
      }
      return <p className="pet-journey-live-body">准备好后，花三分钟完成第一次巩固。</p>;
    case "first_schedule":
      if (refs.reviewScheduleId) {
        return (
          <button type="button" className="pet-journey-live-action" onClick={() => navigate({ kind: "review", scheduleId: refs.reviewScheduleId! })}>
            查看复习安排
          </button>
        );
      }
      return <p className="pet-journey-live-body">巩固完成后，我会根据真实结果安排复习。</p>;
    case "sample_orientation":
      return <p className="pet-journey-live-body">这是隔离示例，不会写入正式学习记录。</p>;
    case "closing":
      return <p className="pet-journey-live-body">引导完成。需要时随时叫我。</p>;
    default:
      return <p className="pet-journey-live-body">正在等待下一步…</p>;
  }
}
