"use client";

import type { CSSProperties } from "react";
import { usePetRuntime } from "../runtime/PetRuntimeProvider";
import { PetIcon, type PetIconNameV1 } from "./PetIcon";
import { PetVoiceVisualizer, type VoiceVisualPhaseV1 } from "./PetVoiceVisualizer";

function controlView(kind: ReturnType<typeof usePetRuntime>["state"]["voice"]["kind"]): {
  label: string;
  shortLabel: string;
  icon: PetIconNameV1;
} {
  switch (kind) {
    case "requesting_permission":
      return { label: "取消启动语音录入", shortLabel: "取消", icon: "close" };
    case "listening":
      return { label: "结束语音录入并开始识别", shortLabel: "结束", icon: "stop" };
    case "finalizing":
    case "transcribing":
      return { label: "正在将语音转成文字", shortLabel: "转文字", icon: "spinner" };
    case "speaking":
      return { label: "打断播报并开始语音录入", shortLabel: "打断", icon: "microphone" };
    case "error":
    case "cancelled":
      return { label: "重新开始语音录入", shortLabel: "重试", icon: "microphone" };
    default:
      return { label: "开始语音录入", shortLabel: "语音", icon: "microphone" };
  }
}

function visualPhase(
  kind: ReturnType<typeof usePetRuntime>["state"]["voice"]["kind"],
): VoiceVisualPhaseV1 | null {
  switch (kind) {
    case "requesting_permission":
    case "listening":
    case "finalizing":
    case "transcribing":
    case "speaking":
      return kind;
    default:
      return null;
  }
}

export function PetVoiceControl({
  left,
  voiceDialogueEnabled,
  fixtureMode,
}: {
  left: number;
  voiceDialogueEnabled: boolean;
  fixtureMode: boolean;
}) {
  const { state, dispatch } = usePetRuntime();
  const { voice } = state;
  const view = controlView(voice.kind);
  const phase = visualPhase(voice.kind);
  const voiceAvailable = voiceDialogueEnabled || fixtureMode;
  const processing = voice.kind === "finalizing" || voice.kind === "transcribing";
  const disabled =
    processing ||
    state.context.voiceOff ||
    !voiceAvailable ||
    state.composer.kind === "submitting" ||
    state.bubble.kind === "confirmation";
  const active =
    voice.kind === "requesting_permission" ||
    voice.kind === "listening" ||
    voice.kind === "speaking" ||
    processing;

  return (
    <>
      {phase ? (
        <div className="pet-voice-island" style={{ left: `var(--pet-voice-island-x, 20px)` }}>
          <PetVoiceVisualizer phase={phase} />
        </div>
      ) : null}
      <div
        className={`pet-voice-control${active ? " is-active" : ""}${processing ? " is-processing" : ""}`}
        style={{ left } as CSSProperties}
        data-voice-phase={voice.kind}
      >
        <button
          type="button"
          className="pet-voice-control-button"
          data-pet-region="voice_control"
          data-pet-voice-control="true"
          data-phase={voice.kind}
          aria-label={state.context.voiceOff ? "语音功能已关闭" : !voiceAvailable ? "语音功能尚未启用" : view.label}
          aria-pressed={voice.kind === "listening"}
          disabled={disabled}
          title={state.context.voiceOff ? "可在伴星设置中开启语音" : !voiceAvailable ? "语音功能尚未启用" : view.label}
          onClick={() => dispatch({ type: "voice.toggle_requested" })}
        >
          <span className="pet-voice-control-spectrum" aria-hidden="true" />
          <PetIcon name={view.icon} />
        </button>
        <span className="pet-voice-control-label" aria-hidden="true">{view.shortLabel}</span>
      </div>
    </>
  );
}
