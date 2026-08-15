import { useEffect, useState } from "react";
import { Icon } from "@/components/ui/icons";
import type { LearningTaskDraftV1, LearningTaskPublicV1, LearningRunUiIntentV1 } from "../contracts";

type TextResponseTaskProps = {
  task: LearningTaskPublicV1 & { interaction: Extract<LearningTaskPublicV1["interaction"], { kind: "text_response" }> };
  onIntent: (intent: LearningRunUiIntentV1) => void;
  draft?: LearningTaskDraftV1;
  onDraftChange?: (draft: LearningTaskDraftV1) => void;
};

export function TextResponseTask({ task, onIntent, draft, onDraftChange }: TextResponseTaskProps) {
  const [localText, setLocalText] = useState(draft?.kind === "text_response" ? draft.text : "");
  const text = draft?.kind === "text_response" ? draft.text : localText;
  const remaining = task.interaction.maxChars - text.length;
  // F#7：提交 busy-lock——双击会在 phase 翻转前并发两条 submit intent，
  // 用 submitting 在首次提交后 disabled 防重。
  const [submitting, setSubmitting] = useState(false);
  // F22（round4）：task 对象身份变化（revision bump / 变体轮转 / snapshot
  // 刷新）时复位 busy-lock——否则锁残留 true → 按钮卡死"正在提交…"无法再
  // 提交（对齐其它 5 个 renderer 的 task 复位）。组件未卸载仅 task 变化时触发。
  useEffect(() => {
    setSubmitting(false);
  }, [task]);

  const updateText = (nextText: string) => {
    setLocalText(nextText);
    onDraftChange?.({ kind: "text_response", text: nextText });
  };

  const handleSubmit = () => {
    if (submitting || !text.trim()) return;
    setSubmitting(true);
    onIntent({ kind: "submit_text", text: text.trim() });
  };

  return (
    <div className="learning-run-response learning-run-response--text">
      <label htmlFor={`learning-run-text-${task.taskId}`}>用你自然的表达回答</label>
      <div className="learning-run-text-shell">
        <textarea
          id={`learning-run-text-${task.taskId}`}
          value={text}
          maxLength={task.interaction.maxChars}
          placeholder={task.interaction.placeholder}
          onChange={(event) => updateText(event.target.value)}
        />
        <div className="learning-run-text-meta">
          <span>不要求术语完整，先说清因果关系</span>
          <span className={remaining < 80 ? "is-low" : ""}>{remaining} 字可用</span>
        </div>
      </div>
      <div className="learning-run-response__submit">
        <button
          className="learning-run-button is-primary"
          type="button"
          disabled={!text.trim() || submitting}
          onClick={handleSubmit}
        >
          {submitting ? "正在提交…" : "锁定并提交回答"}
          <Icon.Arrow aria-hidden="true" />
        </button>
        <p><Icon.Lock aria-hidden="true" />提交后原始回答不会被模型改写。</p>
      </div>
    </div>
  );
}
