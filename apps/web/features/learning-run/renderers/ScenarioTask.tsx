import { useEffect, useState } from "react";
import { Icon } from "@/components/ui/icons";
import type { LearningRunUiIntentV1, LearningTaskDraftV1, LearningTaskPublicV1 } from "../contracts";

type ScenarioTaskProps = {
  task: LearningTaskPublicV1 & { interaction: Extract<LearningTaskPublicV1["interaction"], { kind: "scenario" }> };
  onIntent: (intent: LearningRunUiIntentV1) => void;
  draft?: LearningTaskDraftV1;
  onDraftChange?: (draft: LearningTaskDraftV1) => void;
};

export function ScenarioTask({ task, onIntent, draft, onDraftChange }: ScenarioTaskProps) {
  const initialDraft = draft?.kind === "scenario"
    ? draft
    : { kind: "scenario" as const, choiceId: null, cueIds: [] };
  const [localDraft, setLocalDraft] = useState<Extract<LearningTaskDraftV1, { kind: "scenario" }>>(initialDraft);
  const currentDraft = draft?.kind === "scenario" ? draft : localDraft;
  // F#7：提交 busy-lock——防止双击在 phase 翻转前并发两条 submit intent。
  const [submitting, setSubmitting] = useState(false);

  // 任务/snapshot 变化时重置提交锁。
  useEffect(() => {
    setSubmitting(false);
  }, [task]);

  const updateDraft = (patch: Partial<Extract<LearningTaskDraftV1, { kind: "scenario" }>>) => {
    const nextDraft = { ...currentDraft, ...patch, kind: "scenario" as const };
    setLocalDraft(nextDraft);
    onDraftChange?.(nextDraft);
  };

  const toggleCue = (cueId: string) => {
    updateDraft({
      cueIds: currentDraft.cueIds.includes(cueId)
        ? currentDraft.cueIds.filter((id) => id !== cueId)
        : [...currentDraft.cueIds, cueId],
    });
  };

  return (
    <div className="learning-run-response learning-run-response--scenario">
      <section className="learning-run-scenario-brief" aria-label="应用场景">
        <span aria-hidden="true"><Icon.Target /></span>
        <div><small>具体场景</small><p>{task.interaction.scenario}</p></div>
      </section>

      <fieldset className="learning-run-scenario-choices">
        <legend>你会先做哪一个动作？</legend>
        <div>
          {task.interaction.choices.map((choice) => (
            <label key={choice.id} className={currentDraft.choiceId === choice.id ? "is-selected" : ""}>
              <input
                type="radio"
                name={`scenario-${task.taskId}`}
                value={choice.id}
                checked={currentDraft.choiceId === choice.id}
                onChange={() => updateDraft({ choiceId: choice.id })}
              />
              <span><strong>{choice.label}</strong><small>{choice.consequence}</small></span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="learning-run-rationale-picker">
        <legend>哪些线索让你这样判断？</legend>
        <div>
          {task.interaction.cues.map((cue) => {
            const selected = currentDraft.cueIds.includes(cue.id);
            return (
              <button key={cue.id} type="button" aria-pressed={selected} className={selected ? "is-selected" : ""} onClick={() => toggleCue(cue.id)}>
                <Icon.Check aria-hidden="true" />
                {cue.label}
              </button>
            );
          })}
        </div>
      </fieldset>

      <div className="learning-run-response__submit">
        <button
          className="learning-run-button is-primary"
          type="button"
          disabled={!currentDraft.choiceId || currentDraft.cueIds.length < task.interaction.minCues || submitting}
          onClick={() => {
            if (submitting || !currentDraft.choiceId || currentDraft.cueIds.length < task.interaction.minCues) return;
            setSubmitting(true);
            onIntent({ kind: "submit_scenario", choiceId: currentDraft.choiceId, cueIds: currentDraft.cueIds });
          }}
        >
          {submitting ? "正在提交…" : "提交这个应用判断"}
          <Icon.Arrow aria-hidden="true" />
        </button>
        <p>先做判断，再说明你看见了什么线索。</p>
      </div>
    </div>
  );
}
