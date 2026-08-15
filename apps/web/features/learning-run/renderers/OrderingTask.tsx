import { useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/ui/icons";
import type { LearningTaskDraftV1, LearningTaskPublicV1, LearningRunUiIntentV1 } from "../contracts";

type OrderingTaskProps = {
  task: LearningTaskPublicV1 & { interaction: Extract<LearningTaskPublicV1["interaction"], { kind: "ordering" }> };
  onIntent: (intent: LearningRunUiIntentV1) => void;
  draft?: LearningTaskDraftV1;
  onDraftChange?: (draft: LearningTaskDraftV1) => void;
};

/**
 * 排序题（wire 合同 §12.2）：publicTokenIds 乱序 token + 可选 labels。
 * 用户把 token 按正确顺序放入答案区；确定性评估按位置对比。
 */
export function OrderingTask({ task, onIntent, draft, onDraftChange }: OrderingTaskProps) {
  const [localOrderedIds, setLocalOrderedIds] = useState<string[]>(
    draft?.kind === "ordering" ? draft.orderedTokenIds : [],
  );
  const orderedIds = draft?.kind === "ordering" ? draft.orderedTokenIds : localOrderedIds;
  const labels = task.interaction.publicTokenLabels ?? {};
  const total = task.interaction.publicTokenIds.length;
  const available = task.interaction.publicTokenIds.filter((id) => !orderedIds.includes(id));
  // F#7：提交 busy-lock——防止双击在 phase 翻转前并发两条 submit intent。
  const [submitting, setSubmitting] = useState(false);

  // 任务/snapshot 变化时重置提交锁（复用同一 renderer 的下一个任务可重新提交）。
  useEffect(() => {
    setSubmitting(false);
  }, [task]);

  const labelOf = useMemo(() => (id: string) => labels[id] ?? id, [labels]);

  const updateOrderedIds = (nextIds: string[]) => {
    setLocalOrderedIds(nextIds);
    onDraftChange?.({ kind: "ordering", orderedTokenIds: nextIds });
  };
  const placeNext = (tokenId: string) => updateOrderedIds([...orderedIds, tokenId]);
  const remove = (tokenId: string) => updateOrderedIds(orderedIds.filter((id) => id !== tokenId));

  return (
    <div className="learning-run-response learning-run-response--ordering">
      <div className="learning-run-ordering-grid">
        <section className="learning-run-ordering-pool" aria-labelledby="ordering-pool-title">
          <div className="learning-run-section-heading">
            <span>可选内容</span>
            <small id="ordering-pool-title">点击后放入下一个空位</small>
          </div>
          <div className="learning-run-ordering-items">
            {available.map((tokenId) => (
              <button type="button" key={tokenId} onClick={() => placeNext(tokenId)}>
                <Icon.GripVertical aria-hidden="true" />
                <span>{labelOf(tokenId)}</span>
                <Icon.Plus aria-hidden="true" />
              </button>
            ))}
            {available.length === 0 ? <p className="learning-run-pool-empty">所有内容都已放入，可以提交或调整。</p> : null}
          </div>
        </section>

        <section className="learning-run-ordering-slots" aria-labelledby="ordering-slots-title">
          <div className="learning-run-section-heading">
            <span>你的顺序</span>
            <small id="ordering-slots-title">完成前不会显示对错</small>
          </div>
          <ol>
            {Array.from({ length: total }).map((_, index) => {
              const tokenId = orderedIds[index];
              return (
                <li key={index} className={tokenId ? "is-filled" : ""}>
                  <span className="learning-run-slot-number">{index + 1}</span>
                  {tokenId ? (
                    <button type="button" onClick={() => remove(tokenId)} aria-label={`移除 ${labelOf(tokenId)}`}>
                      <span>{labelOf(tokenId)}</span>
                      <Icon.Close aria-hidden="true" />
                    </button>
                  ) : (
                    <span className="learning-run-slot-empty">第 {index + 1} 位</span>
                  )}
                </li>
              );
            })}
          </ol>
        </section>
      </div>
      <div className="learning-run-response__submit">
        <button
          className="learning-run-button is-primary"
          type="button"
          disabled={orderedIds.length !== total || submitting}
          onClick={() => {
            if (submitting || orderedIds.length !== total) return;
            setSubmitting(true);
            onIntent({ kind: "submit_ordering", orderedTokenIds: orderedIds });
          }}
        >
          {submitting ? "正在提交…" : "锁定这个顺序"}
          <Icon.Arrow aria-hidden="true" />
        </button>
        <p><Icon.Keyboard aria-hidden="true" />所有操作都可用 Tab 与 Enter 完成，不要求拖拽。</p>
      </div>
    </div>
  );
}
