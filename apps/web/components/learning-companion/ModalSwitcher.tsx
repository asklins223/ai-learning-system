"use client";

/**
 * 任务 04-6：模态切换组件（§6.5 / §7.2 / §13.4）。
 *
 * voice ↔ text_or_mixed ↔ structured-proof-v1 三种 canonical 输入模态：
 * - voice：所有支持 voice 的 Key Point 的零打字 canonical 路径（仅当浏览器
 *   支持录音且麦克风可用时开放）；
 * - text_or_mixed：所有 Key Point 的 canonical fallback（始终开放）；
 * - structured-proof-v1：仅对 profile-eligible 目标开放（跨模态 Gold 的
 *   零语音零打字路径）；不合格目标不得展示 silent mastery 路线。
 *
 * 硬门禁（§13.4 / 任务 04-6）：
 * - 不把尚未支持的组合伪装成可验证：不可用的模态不渲染成可点击选项，
 *   只以非交互说明文字解释不可用原因；
 * - 键盘/读屏可完成同等主路径：使用原生 <input type="radio">（同一 name
 *   组），浏览器内置方向键（↑/↓/←/→）在同组内移动焦点并选中，
 *   Tab 进入组、读屏按 role="radio" + aria-checked 播报；
 * - 无倒计时、无操作速度评分：本组件不显示任何计时器/评分。
 *
 * Reduced-motion（§13.4）：当前模态指示为静态高亮，无动画依赖；全局
 * `prefers-reduced-motion: reduce` 禁用动画时呈现不变。
 *
 * 组件为纯 UI：切换动作经 `onSwitch` 注入，不直接调用服务端。
 */

import { useId } from "react";
import { Icon } from "@/components/ui/icons";

export type ModalityId = "voice" | "text_or_mixed" | "structured-proof-v1";

const MODALITY_LABELS: Record<ModalityId, string> = {
  voice: "语音回答",
  text_or_mixed: "文字回答",
  "structured-proof-v1": "结构式证明",
};

const MODALITY_HINTS: Record<ModalityId, string> = {
  voice: "零打字路径：语音逐字转写，确认后提交",
  text_or_mixed: "所有 Key Point 的文字 canonical fallback",
  "structured-proof-v1": "零语音零打字路径：仅对合格目标开放",
};

export interface ModalSwitcherProps {
  /** 当前激活模态 */
  current: ModalityId;
  /** profile-eligible：false 时不渲染 structured-proof 选项 */
  structuredProofEligible: boolean;
  /** 语音能力是否可用（浏览器支持 + 麦克风可申请 + ASR policy 满足） */
  voiceAvailable: boolean;
  /** 切换回调（服务端调用经此注入） */
  onSwitch?: (next: ModalityId) => void;
  /** 进行中（转写/提交中）禁用切换 */
  disabled?: boolean;
  /** 可选文案覆盖（供多语言/上下文定制） */
  labels?: Partial<Record<ModalityId, string>>;
  /** 语音不可用时的解释（如麦克风被拒 / 浏览器不支持 / provider policy 不满足） */
  voiceUnavailableReason?: string;
}

export function ModalSwitcher({
  current,
  structuredProofEligible,
  voiceAvailable,
  onSwitch,
  disabled = false,
  labels,
  voiceUnavailableReason,
}: ModalSwitcherProps) {
  const labelId = useId();
  const nameId = useId();
  const available: ModalityId[] = [
    ...(voiceAvailable ? (["voice"] as const) : []),
    "text_or_mixed",
    ...(structuredProofEligible ? (["structured-proof-v1"] as const) : []),
  ];

  const label = (modality: ModalityId): string => labels?.[modality] ?? MODALITY_LABELS[modality];
  const hint = (modality: ModalityId): string => MODALITY_HINTS[modality];

  return (
    <div
      className="flex flex-col gap-2.5 rounded-card border border-border bg-surface p-3"
      data-testid="modal-switcher"
    >
      <p className="text-xs font-medium text-muted" id={labelId}>
        回答方式
      </p>
      <div
        role="radiogroup"
        aria-labelledby={labelId}
        className="flex flex-wrap gap-2"
      >
        {available.map((modality) => {
          const selected = modality === current;
          return (
            <span key={modality} className="inline-flex">
              <input
                id={`${nameId}-${modality}`}
                type="radio"
                name={nameId}
                value={modality}
                checked={selected}
                disabled={disabled}
                onChange={() => onSwitch?.(modality)}
                className="peer sr-only"
                aria-label={`${label(modality)}：${hint(modality)}`}
              />
              <label
                htmlFor={`${nameId}-${modality}`}
                className={`inline-flex min-h-[44px] cursor-pointer items-center gap-2 rounded-pill border px-4 text-sm font-medium transition-colors motion-reduce:transition-none peer-checked:border-action peer-checked:bg-action peer-checked:text-on-action peer-focus-visible:ring-2 peer-focus-visible:ring-action peer-focus-visible:ring-offset-1 ${
                  selected ? "" : "border-border bg-paper text-ink hover:bg-surface-soft"
                } ${disabled ? "cursor-not-allowed opacity-60" : ""}`}
              >
                {selected ? (
                  <Icon.Check aria-hidden="true" className="size-4" />
                ) : null}
                {label(modality)}
              </label>
            </span>
          );
        })}
      </div>

      {/* 不可用说明（非交互）：不把未支持组合伪装成可验证（§13.4） */}
      {!voiceAvailable ? (
        <p className="text-xs text-muted" role="note" data-testid="modal-switcher-voice-unavailable">
          语音回答当前不可用
          {voiceUnavailableReason ? `：${voiceUnavailableReason}` : "（浏览器或麦克风环境不支持）"}。
          可使用文字回答；合格目标也可使用结构式证明。
        </p>
      ) : null}
      {!structuredProofEligible ? (
        <p className="text-xs text-muted" role="note" data-testid="modal-switcher-proof-unavailable">
          本目标暂不开放结构式证明（仅对 profile-eligible 目标提供）。
        </p>
      ) : null}
    </div>
  );
}
