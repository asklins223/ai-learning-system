"use client";

import { useEffect, useMemo, useState } from "react";
import { PetCharacterCanvas } from "../character/PetCharacterCanvas";
import { createPetAdapter } from "../desktop/desktop-pet-adapter";
import { PetRuntimeProvider } from "../runtime/PetRuntimeProvider";
import { PetIcon } from "../surfaces/PetIcon";
import { PetJourneyPresentation } from "./PetJourneyPresentation";
import {
  PET_JOURNEY_STORY_FRAMES,
  type PetJourneyStoryFrameV2,
} from "./pet-journey-fixtures";
import type { PetJourneyUiIntentV2 } from "./pet-journey-contracts";
import {
  getPetJourneyLabTransition,
  type PetJourneyLabReceipt,
} from "./pet-journey-lab-transitions";

export function PetJourneyRedrawLab() {
  const [frameId, setFrameId] = useState(PET_JOURNEY_STORY_FRAMES[0].frameId);
  const [lastIntent, setLastIntent] = useState<string | null>(null);
  const [intentReceipt, setIntentReceipt] = useState<PetJourneyLabReceipt | null>(null);
  const [renderer, setRenderer] = useState<"loading" | "live2d" | "sprite">("loading");
  const [systemReducedMotion, setSystemReducedMotion] = useState(false);
  const [forceReducedMotionPreview, setForceReducedMotionPreview] = useState(false);
  const adapter = useMemo(() => createPetAdapter(undefined), []);
  const frameIndex = Math.max(0, PET_JOURNEY_STORY_FRAMES.findIndex((item) => item.frameId === frameId));
  const frame = PET_JOURNEY_STORY_FRAMES[frameIndex];
  const reducedMotionPreview = systemReducedMotion || forceReducedMotionPreview;

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setSystemReducedMotion(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  const selectFrame = (next: PetJourneyStoryFrameV2) => {
    setFrameId(next.frameId);
    setLastIntent(null);
    setIntentReceipt(null);
  };

  const move = (delta: number) => {
    const index = Math.min(PET_JOURNEY_STORY_FRAMES.length - 1, Math.max(0, frameIndex + delta));
    selectFrame(PET_JOURNEY_STORY_FRAMES[index]);
  };

  const onIntent = (intent: PetJourneyUiIntentV2) => {
    setLastIntent(intentLabel(intent));
    const transition = getPetJourneyLabTransition(intent, frame.frameId);
    setIntentReceipt(transition.receipt ?? null);
    if (transition.targetFrameId) setFrameId(transition.targetFrameId);
  };

  const silentPresentation = frame.presentation.kind === "silent" ? frame.presentation : null;
  const silent = silentPresentation !== null;
  const silentReason = silentPresentation?.reason === "formal_answer"
    ? "正式作答中：本地抑制全部伴星气泡与主动提示"
    : "勿扰已开启：主动 cue 保留策略判断，但当前不显示";

  return (
    <div className="pet-journey-lab" data-page="pet-journey-redraw">
      <header className="pet-journey-lab__header">
        <div>
          <span className="pet-journey-lab__eyebrow"><PetIcon name="sparkles" /> 系统伴星 UI 重绘 · UI PREVIEW</span>
          <h1>一个角色，一条完整旅程</h1>
          <p>这里验证同一 Live2D 身份上的状态、文案与响应式布局；不代表已经接入真实桌宠运行时。</p>
        </div>
        <div className="pet-journey-lab__contract" role="note">
          <span><i data-state={renderer} />{renderer === "live2d" ? "现有 Live2D 已载入" : renderer === "sprite" ? "预览环境未载入 Live2D" : "正在载入现有 Live2D 资产"}</span>
          <small>仅 UI 故事页 · 未接 PetSurface / API / IPC / 持久化</small>
          <button
            type="button"
            className="pet-journey-motion-toggle"
            aria-pressed={reducedMotionPreview}
            disabled={systemReducedMotion}
            onClick={() => setForceReducedMotionPreview((active) => !active)}
          >
            <PetIcon name={reducedMotionPreview ? "check" : "hide"} />
            {systemReducedMotion
              ? "跟随系统：低动效预览"
              : forceReducedMotionPreview
                ? "结束低动效预览"
                : "预览低动效状态"}
          </button>
          {reducedMotionPreview ? (
            <small>保留同一 Live2D 身份并收敛为 idle；驱动级停帧仍待真实 runtime 接线。</small>
          ) : null}
        </div>
      </header>

      <div className="pet-journey-lab__workspace">
        <nav className="pet-journey-story-rail" aria-label="伴星旅程状态">
          <div className="pet-journey-story-rail__heading">
            <span>旅程状态</span>
            <strong>{PET_JOURNEY_STORY_FRAMES.length} 个关键画面</strong>
          </div>
          <div className="pet-journey-story-rail__list">
            {PET_JOURNEY_STORY_FRAMES.map((item) => (
              <button
                key={item.frameId}
                type="button"
                className={item.frameId === frame.frameId ? "is-active" : ""}
                aria-current={item.frameId === frame.frameId ? "step" : undefined}
                onClick={() => selectFrame(item)}
              >
                <span>{String(item.sequence).padStart(2, "0")}</span>
                <span><strong>{item.label}</strong><small>{item.chapter}</small></span>
              </button>
            ))}
          </div>
        </nav>

        <section className="pet-journey-preview" aria-label={`${frame.label}预览`}>
          <div className="pet-journey-preview__topline">
            <span>{frame.chapter}</span>
            <strong>{frame.label}</strong>
            <small>{frame.note}</small>
          </div>

          {intentReceipt ? (
            <div className="pet-journey-preview__receipt" role="status">
              <span aria-hidden="true"><PetIcon name="shield" /></span>
              <span><strong>{intentReceipt.title}</strong><small>{intentReceipt.detail}</small></span>
              {intentReceipt.returnFrameId ? (
                <button
                  type="button"
                  onClick={() => selectFrame(PET_JOURNEY_STORY_FRAMES.find((item) => item.frameId === intentReceipt.returnFrameId) ?? frame)}
                >
                  {intentReceipt.returnLabel ?? "返回预览"} <PetIcon name="chevron" />
                </button>
              ) : null}
            </div>
          ) : null}

          <div
            className="pet-journey-device-frame"
            data-silent={silent ? "true" : "false"}
            data-reduced-motion={reducedMotionPreview ? "true" : "false"}
          >
            <div className="pet-journey-device-frame__chrome" aria-hidden="true">
              <span><i /><i /><i /></span>
              <b>LIVE2D PET · SYSTEM SURFACE</b>
              <small>{frame.sequence}/{PET_JOURNEY_STORY_FRAMES.length}</small>
            </div>

            <PetRuntimeProvider
              adapter={adapter}
              surfaceKind="pet"
              reducedMotion={reducedMotionPreview}
              animationOff={reducedMotionPreview}
              account={{
                userId: "pet-journey-demo-user",
                workspaceId: "pet-journey-demo-workspace",
                globalEnabled: true,
                accountEpoch: 1,
              }}
            >
              <div
                className="pet-journey-pet-stage"
                data-presentation={reducedMotionPreview ? "idle" : frame.presentation.characterPresentation}
              >
                <div className="pet-journey-character-aura" aria-hidden="true"><i /><i /><i /></div>
                <PetCharacterCanvas
                  presentation={reducedMotionPreview ? "idle" : frame.presentation.characterPresentation}
                  side="bubble-left"
                  petScale={1}
                  // UI-only exception: the current production gate replaces Live2D
                  // when reducedMotion=true. This lab keeps the same model identity;
                  // CSS motion is removed and the pose is reduced to idle instead.
                  reducedMotion={false}
                  animationOff={false}
                  mirror
                  live2dEnabled
                  live2dStageSize={{ width: 260, height: 520 }}
                  onRenderModeChange={(active) => setRenderer(active ? "live2d" : "sprite")}
                />
                <PetJourneyPresentation presentation={frame.presentation} onIntent={onIntent} />
                {silentPresentation ? (
                  <div className="pet-journey-silent-proof" role="status">
                    <PetIcon name={silentPresentation.reason === "dnd" ? "hide" : "shield"} />
                    <span><strong>伴星界面已静默</strong><small>{silentReason}</small></span>
                  </div>
                ) : null}
              </div>
            </PetRuntimeProvider>
          </div>

          <footer className="pet-journey-preview__footer">
            <button type="button" className="pet-journey-preview__nav" disabled={frameIndex === 0} onClick={() => move(-1)}>
              <PetIcon name="back" /> 上一个状态
            </button>
            <div aria-live="polite">
              <span>{lastIntent ? "最近交互" : "状态约束"}</span>
              <strong>{lastIntent ?? frame.note}</strong>
            </div>
            <button type="button" className="pet-journey-preview__nav is-next" disabled={frameIndex === PET_JOURNEY_STORY_FRAMES.length - 1} onClick={() => move(1)}>
              下一个状态 <PetIcon name="chevron" />
            </button>
          </footer>
        </section>
      </div>
    </div>
  );
}

function intentLabel(intent: PetJourneyUiIntentV2): string {
  switch (intent.kind) {
    case "choose_invitation": return `选择首次路线：${intent.branch}`;
    case "defer_invitation": return "首次邀请已延期，不等于跳过";
    case "set_preference": return `确认偏好：${intent.preference} = ${intent.value}`;
    case "skip_preference": return `跳过偏好：${intent.preference}`;
    case "progress_action": return `执行材料动作：${intent.action}`;
    case "open_run_proposal": return "查看 LearningRun 影响并进入确认";
    case "reject_run_proposal": return "拒绝本次 LearningRun 提议";
    case "confirm_action": return "确认 typed action";
    case "reject_action": return "取消 typed action";
    case "leave_execution": return "收起执行状态，等待持久回执";
    case "result_action": return `打开真实结果目标：${intent.action}`;
    case "retry_recovery": return "重试可恢复操作";
    case "dismiss_recovery": return "先离开，保留恢复入口";
    case "dismiss": return "关闭当前呈现";
  }
}
