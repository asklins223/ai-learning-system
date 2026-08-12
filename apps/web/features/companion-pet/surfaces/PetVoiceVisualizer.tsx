import React from "react";
import type { VoiceDialogueStateV1 } from "../runtime/pet-runtime-types";

export type VoiceVisualPhaseV1 = Extract<
  VoiceDialogueStateV1["kind"],
  "requesting_permission" | "listening" | "finalizing" | "transcribing" | "speaking"
>;

const COPY: Record<VoiceVisualPhaseV1, { title: string; hint: string }> = {
  requesting_permission: {
    title: "准备麦克风",
    hint: "点按按钮可取消",
  },
  listening: {
    title: "正在听你说",
    hint: "说完再点一下结束",
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
 * Siri 式极简分态语音岛：
 * - 聆听/准备：青色声纹柱左右起伏（对准你的声音）
 * - 收声/识别：琥珀色弧形环旋转（系统在处理）
 * - 伴星说：绿色声波从中心向外扩散（声音从伴星出来）
 * 三种状态形状、颜色、动效完全不同，一眼可辨。
 */
export function PetVoiceVisualizer({ phase }: { phase: VoiceVisualPhaseV1 }) {
  const copy = COPY[phase];
  const processing = phase === "requesting_permission" || phase === "finalizing" || phase === "transcribing";

  return (
    <div
      className={`pet-voice-island-content${processing ? " is-processing" : " is-listening"}`}
      data-voice-visual={phase}
      role="status"
      aria-live="polite"
    >
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
      <span className="pet-voice-island-copy">
        <strong>{copy.title}</strong>
        <small>{copy.hint}</small>
      </span>
    </div>
  );
}
