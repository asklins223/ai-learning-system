"use client";

/**
 * 验证页伴星输入接线层（阶段 04-6 + 07-5 接线）。
 *
 * 挂在 `/cards/[id]/validate?keyPoint=` 页面上，位于 ValidationFocus 之上：
 * - `ModalSwitcher`：voice ↔ text_or_mixed ↔ structured-proof 模态切换
 *   （不把未支持组合伪装成可验证；语音不可用时只显示可用的 text 选项）；
 * - `VoiceInputPanel`：麦克风状态机面板（录制/重听/确认/重录/切换 text；
 *   麦克风被拒 → 文字 fallback 无操作死路；无倒计时/无速度评分）；
 * - `TextOrMixedInput`：text_or_mixed canonical fallback（原始文本 + hash 语义）。
 *
 * 服务端调用经 props 注入：本层只负责 UI 编排，不直接调用网络；
 * 实际 ASR/transcript 端点由宿主应用接入（04-1 voice-service 端点）。
 * 文字提交复用 ValidationFocus 的既有 question-first 提交语义（v0.6 兼容）。
 */

import { useState } from "react";
import { ModalSwitcher } from "./ModalSwitcher";
import { VoiceInputPanel } from "./VoiceInputPanel";
import { TextOrMixedInput } from "./TextOrMixedInput";
import type { ModalityId } from "./ModalSwitcher";
import type { TranscriptionOutcome } from "@/lib/learning-companion/voice-api";

export interface ValidationVoiceEntryProps {
  cardId: string;
  keyPointId: string;
  /** 冻结 probe id（由宿主从 Session plan 提供；缺省用 keyPointId 占位）。 */
  probeId?: string;
  publicSceneHash?: string;
  baseRevision?: number;
  /** profile-eligible：true 时才出现 structured-proof 入口（§13.4）。 */
  structuredProofEligible?: boolean;
  /** 语音能力整体不可用（浏览器不支持 / 麦克风被拒 / ASR policy 不满足）。 */
  voiceUnavailable?: boolean;
  /** ASR 转写注入（宿主接 04-1 voice-service）。 */
  onTranscribe?: (
    audio: Blob,
    meta: { language?: string; artifactId?: string },
  ) => Promise<TranscriptionOutcome>;
  /** 确认 transcript 注入（→ locked）。 */
  onConfirm?: (input: { artifactId: string; confirmedTranscript: string }) => Promise<void>;
  /** 重录注入（可选）。 */
  onReRecord?: (input: { previousArtifactId: string; audio: Blob }) => Promise<{ artifactId: string }>;
  /** 文字提交（必填：验证页文字主路径）。 */
  onSubmitText: (text: string) => Promise<void> | void;
  /** 切换结构式证明（可选）。 */
  onSwitchToStructuredProof?: () => void;
}

export function ValidationVoiceEntry({
  cardId,
  keyPointId,
  probeId = keyPointId,
  publicSceneHash = "not-available",
  baseRevision = 0,
  structuredProofEligible = false,
  voiceUnavailable = false,
  onTranscribe,
  onConfirm,
  onReRecord,
  onSubmitText,
  onSwitchToStructuredProof,
}: ValidationVoiceEntryProps) {
  const [modality, setModality] = useState<ModalityId>(
    voiceUnavailable ? "text_or_mixed" : "voice",
  );
  const [submitting, setSubmitting] = useState(false);

  const voiceAvailable = !voiceUnavailable && Boolean(onTranscribe);

  const handleSubmitText = async (text: string) => {
    setSubmitting(true);
    try {
      await onSubmitText(text);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="validation-voice-entry" data-ui="validation-voice-entry">
      <ModalSwitcher
        current={modality}
        structuredProofEligible={structuredProofEligible}
        voiceAvailable={voiceAvailable}
        onSwitch={(next) => setModality(next)}
        disabled={submitting}
        voiceUnavailableReason={
          voiceUnavailable ? "语音能力当前不可用（麦克风被拒或 ASR 策略未满足），可使用文字输入。" : undefined
        }
      />

      {modality === "voice" && voiceAvailable && (
        <VoiceInputPanel
          episodeId={cardId}
          keyPointId={keyPointId}
          probeId={probeId}
          publicSceneHash={publicSceneHash}
          baseRevision={baseRevision}
          structuredProofEligible={structuredProofEligible}
          onTranscribe={onTranscribe as never}
          onConfirm={onConfirm ?? (async () => {})}
          onReRecord={onReRecord}
          onSubmitText={({ text }) => handleSubmitText(text)}
          onSwitchToStructuredProof={onSwitchToStructuredProof}
        />
      )}

      {modality === "text_or_mixed" && (
        <TextOrMixedInput
          onSubmit={({ text }) => handleSubmitText(text)}
        />
      )}

      {modality === "structured-proof-v1" && (
        <div className="validation-voice-entry__proof-hint" role="note">
          <p>结构式证明（structured-proof-v1）：按冻结 Scene 完成排序 / 修复 / 关系重建。</p>
          {onSwitchToStructuredProof ? (
            <button type="button" onClick={onSwitchToStructuredProof} className="validation-voice-entry__action">
              开始结构式证明
            </button>
          ) : (
            <p className="validation-voice-entry__muted">（接线中：宿主应用接入 Scene 渲染后开放）</p>
          )}
        </div>
      )}
    </div>
  );
}
