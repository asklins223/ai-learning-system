import React from "react";
import type { VoiceDialogueStateV1 } from "../runtime/pet-runtime-types";
import { LiquidOrb } from "@/components/liquid-orb/LiquidOrb";
import { PET_VOICE_ORB_VISUALS } from "@/components/liquid-orb/liquid-orb-presets";

export type VoiceVisualPhaseV1 = Extract<
  VoiceDialogueStateV1["kind"],
  "requesting_permission" | "listening" | "finalizing" | "transcribing" | "speaking"
>;

const COPY: Record<VoiceVisualPhaseV1, { title: string; hint: string }> = {
  requesting_permission: {
    title: "准备麦克风",
    hint: "松开可取消",
  },
  listening: {
    title: "正在听你说",
    hint: "松开即可发送",
  },
  finalizing: {
    title: "正在收好声音",
    hint: "马上开始识别",
  },
  transcribing: {
    title: "正在识别",
    hint: "把声音变成文字",
  },
  speaking: {
    title: "伴星正在说",
    hint: "点按可以打断",
  },
};

/**
 * 液态玻璃球分态语音岛（模板 Liquid Orb 重构，2026-08）：
 * - 准备/聆听：Siri 声纹带（青色）——对准你的声音
 * - 收声/识别：频谱波形面（琥珀色）——系统在处理
 * - 播报：声膜（绿色）——声音从伴星出来
 * 三种状态形状、颜色、动效完全不同，一眼可辨；WebGPU 不可用时
 * 回退旧 CSS 三态（bars / ring / waves）视觉。
 */
export function PetVoiceVisualizer({
  phase,
  paused = false,
  reducedMotion = false,
}: {
  phase: VoiceVisualPhaseV1;
  /** 窗口被完全遮挡时暂停渲染（保留最后一帧）。 */
  paused?: boolean;
  /** prefers-reduced-motion / animationOff。 */
  reducedMotion?: boolean;
}) {
  const copy = COPY[phase];
  const processing = phase === "requesting_permission" || phase === "finalizing" || phase === "transcribing";
  const visual = PET_VOICE_ORB_VISUALS[phase];

  return (
    <div
      className={`pet-voice-island-content${processing ? " is-processing" : " is-listening"}`}
      data-voice-visual={phase}
      role="status"
      aria-live="polite"
    >
      <LiquidOrb
        preset={visual.preset}
        tone={visual.tone}
        intensity={visual.intensity}
        size={44}
        radius={0.85}
        paused={paused}
        reducedMotion={reducedMotion}
        className="pet-voice-liquid-orb"
        fallback={(
          <span className="pet-voice-orb" aria-hidden="true">
            <span className="pet-voice-bars">
              <i /><i /><i /><i /><i /><i /><i />
            </span>
            <svg className="pet-voice-ring" viewBox="0 0 44 44" focusable="false">
              <circle className="pet-voice-ring-track" cx="22" cy="22" r="16" />
              <circle className="pet-voice-ring-arc" cx="22" cy="22" r="16" />
            </svg>
            <span className="pet-voice-waves">
              <i /><i /><i />
            </span>
          </span>
        )}
      />
      <span className="pet-voice-island-copy">
        <strong>{copy.title}</strong>
        <small>{copy.hint}</small>
      </span>
    </div>
  );
}
