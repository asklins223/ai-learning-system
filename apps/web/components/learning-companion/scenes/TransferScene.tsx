"use client";

/**
 * 任务 14 阶段 C：TransferScene（transfer 情境题渲染，14 方案 §3.1 / 附录 A）。
 *
 * 06-6 transfer 三种形态：
 * - situated_application（情境应用）→ multi_step_scenario（多步情境决策）；
 * - repair（故障修复）→ repair Scene（复用 TapSelectPlaceLayer 修复位）；
 * - boundary_variant（边界变式）→ counterexample/条件变式。
 *
 * 不变量（06-6，fail closed）：
 * - 只在宿主 gate 通过（rubricComplete + evidenceComplete）时开放——本组件
 *   本身不裁决 gate，入口由宿主用 `resolveAnswerMode`/transfer gate 判定；
 * - 默认 `record_only`：本组件不消费/不修改 schedule，结果页明示
 *   「本次未改变复习时间」由宿主承担；
 * - 复用 TapSelectPlaceLayer 的 tap-select-place 等价路径（A11y，§13.4）；
 * - 完成前不揭示对错（formal 无中途反馈）；无计时、无速度评分。
 */

import { useMemo, useState } from "react";
import { SceneType, type LearningScene } from "@ailearn/shared";
import { TapSelectPlaceLayer } from "../TapSelectPlaceLayer";
import { adaptRepairToTapSelect } from "./SilentProofScene";
import { Icon } from "@/components/ui/icons";

export type TransferForm = "situated_application" | "repair" | "boundary_variant";

export interface TransferSceneProps {
  /** 06-6 三种形态之一（宿主管制：只有 gate 通过才渲染本组件）。 */
  transferForm: TransferForm;
  /** 净化题面（public payload）：multi_step_scenario / repair / counterexample 的 public 部分。 */
  scene: LearningScene;
  /** 完成后提交（record_only 语义由宿主/服务端裁决）。 */
  onSubmit?: (payload: unknown) => Promise<void> | void;
  ariaLabel?: string;
}

/** 形态 → 展示标签（§3.1 表格 transfer 行）。 */
export function transferFormLabel(form: TransferForm): string {
  switch (form) {
    case "situated_application": return "情境应用";
    case "repair": return "故障修复";
    case "boundary_variant": return "边界变式";
  }
}

export function TransferScene({
  transferForm,
  scene,
  onSubmit,
  ariaLabel = "情境应用题（不影响复习时间）",
}: TransferSceneProps) {
  const [locked, setLocked] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitFailed, setSubmitFailed] = useState(false);

  const repairScene = useMemo(
    () => scene.sceneType === SceneType.REPAIR ? adaptRepairToTapSelect(scene.public as never) : null,
    [scene],
  );

  const handleSubmit = (payload: unknown) => {
    setSubmitFailed(false);
    if (!onSubmit) {
      setLocked(true);
      return;
    }
    void (async () => {
      setSubmitting(true);
      try {
        await onSubmit(payload);
        setLocked(true);
      } catch {
        // 不把失败伪装成已提交（§3.6）：提交失败回落，提示改用文字或语音回答。
        setSubmitFailed(true);
      } finally {
        setSubmitting(false);
      }
    })();
  };

  return (
    <div
      className="flex flex-col gap-3 rounded-card border border-border bg-surface p-4"
      data-testid="transfer-scene"
      data-transfer-form={transferForm}
      aria-label={ariaLabel}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium text-ink">{transferFormLabel(transferForm)}</p>
        <span className="inline-flex min-h-[44px] items-center gap-1.5 rounded-pill bg-surface-soft px-3 text-xs text-muted">
          <Icon.Lock aria-hidden="true" className="size-3.5" />
          <span>本次未改变复习时间（record_only）</span>
        </span>
      </div>

      {transferForm === "repair" && repairScene !== null ? (
        <TapSelectPlaceLayer
          scene={repairScene}
          ariaLabel={`${transferFormLabel(transferForm)}（点选放置）`}
          onLock={() => handleSubmit({ transferForm, sceneId: scene.sceneId })}
        />
      ) : transferForm === "situated_application" && scene.sceneType === SceneType.MULTI_STEP_SCENARIO ? (
        <MultiStepTransfer
          scene={scene}
          onSubmit={(choices) => handleSubmit({ transferForm, sceneId: scene.sceneId, choices })}
          submitting={submitting}
        />
      ) : (
        <p className="text-sm text-muted" role="note" data-testid="transfer-unavailable">
          这类情境题暂未开放，请换用文字或语音回答。
        </p>
      )}

      {locked ? (
        <p className="text-sm text-success-text" role="status">
          <Icon.Check aria-hidden="true" className="size-4" />
          情境题已提交（不影响复习时间）。
        </p>
      ) : null}
      {submitFailed ? (
        <p className="text-sm text-danger-text" role="alert">
          提交失败，学习状态没有改变。请改用文字或语音回答。
        </p>
      ) : null}
    </div>
  );
}

/** 多步情境决策（multi_step_scenario）：逐步选择，无中途反馈。 */
function MultiStepTransfer({
  scene,
  onSubmit,
  submitting,
}: {
  scene: Extract<LearningScene, { sceneType: typeof SceneType.MULTI_STEP_SCENARIO }>;
  onSubmit: (choices: Array<{ stepId: string; optionId: string }>) => void;
  submitting: boolean;
}) {
  const steps = scene.public.steps;
  const [currentIndex, setCurrentIndex] = useState(0);
  const [choices, setChoices] = useState<Array<{ stepId: string; optionId: string }>>([]);

  const current = steps[currentIndex];
  const allDone = currentIndex >= steps.length;

  const choose = (optionId: string) => {
    if (!current || submitting) return;
    const nextChoices = [...choices, { stepId: current.stepId, optionId }];
    setChoices(nextChoices);
    if (currentIndex + 1 >= steps.length) {
      onSubmit(nextChoices);
    } else {
      setCurrentIndex(currentIndex + 1);
    }
  };

  return (
    <div className="flex flex-col gap-3" data-testid="multi-step-transfer">
      <p className="text-sm leading-relaxed text-ink">{scene.public.scenarioText}</p>
      {current ? (
        <fieldset className="flex flex-col gap-2 border-0 p-0 m-0">
          <legend className="text-sm font-medium text-ink">
            第 {currentIndex + 1} 步（共 {steps.length} 步）
          </legend>
          {current.optionIds.map((optionId, index) => (
            <button
              key={optionId}
              type="button"
              onClick={() => choose(optionId)}
              disabled={submitting}
              className="inline-flex min-h-[44px] items-center gap-2 rounded-pill border border-border px-4 text-left text-sm font-medium text-ink hover:bg-surface-soft motion-reduce:transition-none"
            >
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-soft text-xs text-muted" aria-hidden="true">
                {index + 1}
              </span>
              {current.optionTexts[index] ?? optionId}
            </button>
          ))}
        </fieldset>
      ) : allDone ? (
        <p className="text-sm text-success-text" role="status">
          <Icon.Check aria-hidden="true" className="size-4" />
          全部步骤已完成，正在提交…
        </p>
      ) : null}
      <p className="text-xs text-muted" role="note">
        完成前不揭示对错；本次作答不影响复习时间安排。
      </p>
    </div>
  );
}
