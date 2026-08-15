import { useEffect, useState } from "react";
import { Icon } from "@/components/ui/icons";
import type { LearningTaskDraftV1, LearningTaskPublicV1, LearningRunUiIntentV1 } from "../contracts";

type RepairTaskProps = {
  task: LearningTaskPublicV1 & { interaction: Extract<LearningTaskPublicV1["interaction"], { kind: "repair" }> };
  onIntent: (intent: LearningRunUiIntentV1) => void;
  draft?: LearningTaskDraftV1;
  onDraftChange?: (draft: LearningTaskDraftV1) => void;
};

/**
 * 修复题（wire 合同 §12.2）：选元素 + 选替换项（确定性填空式修复）。
 * 服务端确定性评估按 acceptedOperationSignatures 对比。
 */
export function RepairTask({ task, onIntent, draft, onDraftChange }: RepairTaskProps) {
  const initialDraft = draft?.kind === "repair"
    ? draft
    : { kind: "repair" as const, elementId: null, replacementOptionId: null };
  const [localDraft, setLocalDraft] = useState<Extract<LearningTaskDraftV1, { kind: "repair" }>>(initialDraft);
  const currentDraft = draft?.kind === "repair" ? draft : localDraft;
  const { elementId, replacementOptionId } = currentDraft;
  const elementLabels = task.interaction.publicElementLabels ?? {};
  const optionLabels = task.interaction.replacementOptionLabels ?? {};
  const canReplace = task.interaction.allowedOperationKinds.includes("replace");
  // F#7：提交 busy-lock——防止双击在 phase 翻转前并发两条 submit intent。
  const [submitting, setSubmitting] = useState(false);

  // 任务/snapshot 变化时重置提交锁。
  useEffect(() => {
    setSubmitting(false);
  }, [task]);

  const updateDraft = (patch: Partial<Extract<LearningTaskDraftV1, { kind: "repair" }>>) => {
    const nextDraft = { ...currentDraft, ...patch, kind: "repair" as const };
    setLocalDraft(nextDraft);
    onDraftChange?.(nextDraft);
  };

  return (
    <div className="learning-run-response learning-run-response--repair">
      <fieldset>
        <legend>先选出需要修复的一处</legend>
        <div className="learning-run-choice-list">
          {task.interaction.publicElementIds.map((id) => (
            <label key={id} className={elementId === id ? "is-selected" : ""}>
              <input
                type="radio"
                name="repair-element"
                value={id}
                checked={elementId === id}
                onChange={() => updateDraft({ elementId: id, replacementOptionId: null })}
              />
              <span>{elementLabels[id] ?? id}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend>{canReplace ? "选择替换内容" : "选择修复动作"}</legend>
        <div className="learning-run-operation-list">
          {task.interaction.replacementOptionIds.map((optionId) => (
            <label key={optionId} className={replacementOptionId === optionId ? "is-selected" : ""}>
              <input
                type="radio"
                name="repair-option"
                value={optionId}
                checked={replacementOptionId === optionId}
                onChange={() => updateDraft({ replacementOptionId: optionId })}
              />
              <span>{optionLabels[optionId] ?? optionId}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="learning-run-response__submit">
        <button
          className="learning-run-button is-primary"
          type="button"
          disabled={!elementId || !replacementOptionId || submitting}
          onClick={() => {
            if (submitting || !elementId || !replacementOptionId) return;
            setSubmitting(true);
            onIntent({
              kind: "submit_repair",
              elementId,
              replacementOptionId,
            });
          }}
        >
          {submitting ? "正在提交…" : "提交修复方案"}
          <Icon.Arrow aria-hidden="true" />
        </button>
        <p><Icon.Lock aria-hidden="true" />提交后由独立评估判定，不会提前显示对错。</p>
      </div>
    </div>
  );
}
