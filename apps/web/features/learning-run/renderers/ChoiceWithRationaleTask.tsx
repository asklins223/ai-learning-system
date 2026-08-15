import { useEffect, useState } from "react";
import { Icon } from "@/components/ui/icons";
import type { LearningRunUiIntentV1, LearningTaskDraftV1, LearningTaskPublicV1 } from "../contracts";

type ChoiceWithRationaleTaskProps = {
  task: LearningTaskPublicV1 & { interaction: Extract<LearningTaskPublicV1["interaction"], { kind: "choice_with_rationale" }> };
  onIntent: (intent: LearningRunUiIntentV1) => void;
  draft?: LearningTaskDraftV1;
  onDraftChange?: (draft: LearningTaskDraftV1) => void;
};

export function ChoiceWithRationaleTask({ task, onIntent, draft, onDraftChange }: ChoiceWithRationaleTaskProps) {
  const initialDraft = draft?.kind === "choice_with_rationale"
    ? draft
    : { kind: "choice_with_rationale" as const, choiceId: null, rationaleIds: [] };
  const [localDraft, setLocalDraft] = useState<Extract<LearningTaskDraftV1, { kind: "choice_with_rationale" }>>(initialDraft);
  const currentDraft = draft?.kind === "choice_with_rationale" ? draft : localDraft;
  // F#7：提交 busy-lock——防止双击在 phase 翻转前并发两条 submit intent。
  const [submitting, setSubmitting] = useState(false);

  // 任务/snapshot 变化时重置提交锁。
  useEffect(() => {
    setSubmitting(false);
  }, [task]);

  const updateDraft = (patch: Partial<Extract<LearningTaskDraftV1, { kind: "choice_with_rationale" }>>) => {
    const nextDraft = { ...currentDraft, ...patch, kind: "choice_with_rationale" as const };
    setLocalDraft(nextDraft);
    onDraftChange?.(nextDraft);
  };

  const toggleRationale = (rationaleId: string) => {
    updateDraft({
      rationaleIds: currentDraft.rationaleIds.includes(rationaleId)
        ? currentDraft.rationaleIds.filter((id) => id !== rationaleId)
        : [...currentDraft.rationaleIds, rationaleId],
    });
  };

  return (
    <div className="learning-run-response learning-run-response--choice-rationale">
      <fieldset className="learning-run-card-choice">
        <legend>先选最接近你理解的一种说法</legend>
        <div>
          {task.interaction.choices.map((choice) => (
            <label key={choice.id} className={currentDraft.choiceId === choice.id ? "is-selected" : ""}>
              <input
                type="radio"
                name={`choice-${task.taskId}`}
                value={choice.id}
                checked={currentDraft.choiceId === choice.id}
                onChange={() => updateDraft({ choiceId: choice.id })}
              />
              <span><strong>{choice.label}</strong>{choice.detail ? <small>{choice.detail}</small> : null}</span>
              <Icon.Check aria-hidden="true" />
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="learning-run-rationale-picker">
        <legend>再点出它成立的关键理由</legend>
        <p>不需要写作文；理由会与所选说法一起成为本次回答。</p>
        <div>
          {task.interaction.rationales.map((rationale) => {
            const selected = currentDraft.rationaleIds.includes(rationale.id);
            return (
              <button key={rationale.id} type="button" aria-pressed={selected} className={selected ? "is-selected" : ""} onClick={() => toggleRationale(rationale.id)}>
                <Icon.Check aria-hidden="true" />
                {rationale.label}
              </button>
            );
          })}
        </div>
      </fieldset>

      <div className="learning-run-response__submit">
        <button
          className="learning-run-button is-primary"
          type="button"
          disabled={!currentDraft.choiceId || currentDraft.rationaleIds.length < task.interaction.minRationales || submitting}
          onClick={() => {
            if (submitting || !currentDraft.choiceId || currentDraft.rationaleIds.length < task.interaction.minRationales) return;
            setSubmitting(true);
            onIntent({
              kind: "submit_choice_with_rationale",
              choiceId: currentDraft.choiceId,
              rationaleIds: currentDraft.rationaleIds,
            });
          }}
        >
          {submitting ? "正在提交…" : "锁定这组理解"}
          <Icon.Arrow aria-hidden="true" />
        </button>
        <p><Icon.Keyboard aria-hidden="true" />点选即可完成，也支持 Tab 与 Enter。</p>
      </div>
    </div>
  );
}
