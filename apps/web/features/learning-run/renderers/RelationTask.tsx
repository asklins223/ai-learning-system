import { useEffect, useState } from "react";
import { Icon } from "@/components/ui/icons";
import type { LearningRunUiIntentV1, LearningTaskDraftV1, LearningTaskPublicV1 } from "../contracts";

type RelationTaskProps = {
  task: LearningTaskPublicV1 & { interaction: Extract<LearningTaskPublicV1["interaction"], { kind: "relation" }> };
  onIntent: (intent: LearningRunUiIntentV1) => void;
  draft?: LearningTaskDraftV1;
  onDraftChange?: (draft: LearningTaskDraftV1) => void;
};

const EDGE_KIND_LABELS: Record<string, string> = {
  supports: "支持 / 支撑",
  causes: "导致",
  part_of: "属于一部分",
  contrasts_with: "与之对照",
  precedes: "先于",
  depends_on: "依赖",
};

/**
 * 关系题（wire 合同 §12.2）：两节点（如 原文↔论点）+ allowedEdgeKinds。
 * 用户选边方向与关系类型；确定性评估按 requiredEdges 对比。
 */
export function RelationTask({ task, onIntent, draft, onDraftChange }: RelationTaskProps) {
  const initialDraft = draft?.kind === "relation"
    ? draft
    : { kind: "relation" as const, fromNodeId: null, toNodeId: null, edgeKind: null };
  const [localDraft, setLocalDraft] = useState<Extract<LearningTaskDraftV1, { kind: "relation" }>>(initialDraft);
  const currentDraft = draft?.kind === "relation" ? draft : localDraft;
  const nodeLabels = task.interaction.publicNodeLabels ?? {};
  const [firstId, secondId] = task.interaction.publicNodeIds;
  // F#7：提交 busy-lock——防止双击在 phase 翻转前并发两条 submit intent。
  const [submitting, setSubmitting] = useState(false);
  // F22（round4）：task 对象身份变化（revision bump / 变体轮转 / snapshot
  // 刷新）时复位 busy-lock——否则按钮卡死"正在提交…"无法再提交
  // （对齐其它 renderer 的 task 复位）。
  useEffect(() => {
    setSubmitting(false);
  }, [task]);

  const labelOf = (id: string | undefined) => (id ? nodeLabels[id] ?? id : "");

  const updateDraft = (patch: Partial<Extract<LearningTaskDraftV1, { kind: "relation" }>>) => {
    const nextDraft = { ...currentDraft, ...patch, kind: "relation" as const };
    setLocalDraft(nextDraft);
    onDraftChange?.(nextDraft);
  };

  const pickDirection = (from: string, to: string) => {
    updateDraft({ fromNodeId: from, toNodeId: to });
  };

  return (
    <div className="learning-run-response learning-run-response--relation">
      <div className="learning-run-relation-board">
        <button
          type="button"
          className={`learning-run-relation-node${currentDraft.fromNodeId === firstId ? " is-selected" : ""}`}
          onClick={() => firstId && secondId && pickDirection(firstId, secondId)}
          aria-pressed={currentDraft.fromNodeId === firstId}
        >
          <small>起点</small>
          <strong>{labelOf(firstId)}</strong>
        </button>
        <span className="learning-run-relation-arrow" aria-hidden="true"><Icon.Arrow /></span>
        <button
          type="button"
          className={`learning-run-relation-node${currentDraft.toNodeId === secondId ? " is-selected" : ""}`}
          onClick={() => firstId && secondId && pickDirection(secondId, firstId)}
          aria-pressed={currentDraft.toNodeId === secondId}
        >
          <small>终点</small>
          <strong>{labelOf(secondId)}</strong>
        </button>
      </div>
      <p className="learning-run-relation-direction-hint">点击一个节点作为关系起点，箭头指向终点。</p>

      <fieldset className="learning-run-rationale-picker">
        <legend>这两者是什么关系？</legend>
        <div>
          {task.interaction.allowedEdgeKinds.map((edgeKind) => {
            const selected = currentDraft.edgeKind === edgeKind;
            return (
              <button
                key={edgeKind}
                type="button"
                aria-pressed={selected}
                className={selected ? "is-selected" : ""}
                onClick={() => updateDraft({ edgeKind })}
              >
                <Icon.Check aria-hidden="true" />
                {EDGE_KIND_LABELS[edgeKind] ?? edgeKind}
              </button>
            );
          })}
        </div>
      </fieldset>

      <div className="learning-run-response__submit">
        <button
          className="learning-run-button is-primary"
          type="button"
          disabled={!currentDraft.fromNodeId || !currentDraft.toNodeId || !currentDraft.edgeKind || submitting}
          onClick={() => {
            if (submitting) return;
            if (!currentDraft.fromNodeId || !currentDraft.toNodeId || !currentDraft.edgeKind) return;
            setSubmitting(true);
            onIntent({
              kind: "submit_relation",
              fromNodeId: currentDraft.fromNodeId,
              toNodeId: currentDraft.toNodeId,
              edgeKind: currentDraft.edgeKind,
            });
          }}
        >
          {submitting ? "正在提交…" : "锁定这条关系"}
          <Icon.Arrow aria-hidden="true" />
        </button>
        <p>这是一条结构化关系，不要求再写解释。</p>
      </div>
    </div>
  );
}
