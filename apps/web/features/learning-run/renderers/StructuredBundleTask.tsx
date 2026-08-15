"use client";

/**
 * StructuredBundleTask（方案 16 §5.3/§7.3/§12.3，V1 practice 首发）。
 *
 * - 两个互补 part 顺序完成（ordering → relation）；
 * - part 完成只保存在 draft（§12.7：任一 part 都不能单独 lock/排队 Assessment）；
 * - 全部 part 完成后一次原子提交 bundle Artifact；
 * - 交互与单 part renderer 等价：tap-select-place（点选排序）、关系选择，
 *   不要求拖拽。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type {
  LearningTaskDraftV1,
  LearningTaskPublicV1,
  LearningRunUiIntentV1,
} from "../contracts";

type BundleInteraction = Extract<LearningTaskPublicV1["interaction"], { kind: "structured_bundle" }>;

type PartAnswer =
  | { kind: "ordering"; orderedTokenIds: string[] }
  | { kind: "relation"; edges: Array<{ fromNodeId: string; toNodeId: string; edgeKind: string }> };

interface StructuredBundleTaskProps {
  task: LearningTaskPublicV1 & { interaction: BundleInteraction };
  onIntent: (intent: LearningRunUiIntentV1) => void;
  draft?: LearningTaskDraftV1;
  onDraftChange?: (draft: LearningTaskDraftV1) => void;
}

function partInitialAnswers(draft?: LearningTaskDraftV1): [PartAnswer | null, PartAnswer | null] {
  if (draft?.kind === "structured_bundle") {
    const first = draft.partAnswers[0] as PartAnswer | undefined;
    const second = draft.partAnswers[1] as PartAnswer | undefined;
    return [first ?? null, second ?? null];
  }
  return [null, null];
}

export function StructuredBundleTask({ task, onIntent, draft, onDraftChange }: StructuredBundleTaskProps) {
  const parts = task.interaction.parts;
  const orderingPart = parts[0]?.interaction.kind === "ordering" ? parts[0] : null;
  const relationPart = parts[1]?.interaction.kind === "relation_canvas" ? parts[1] : null;

  const [answers, setAnswers] = useState<[PartAnswer | null, PartAnswer | null]>(() => partInitialAnswers(draft));
  const [selectedTokens, setSelectedTokens] = useState<string[]>([]);
  // F11：提交 busy-lock——提交 button 双击可二次 submit，加 submitting
  // 状态在提交期间 disabled，防止在首次 Promise resolve 前再次触发。
  const [submitting, setSubmitting] = useState(false);
  // 第八轮 🟡B-5：记录提交锁上次初始化归属的 taskId。active 阶段快照每 2s
  // 更新使 task 引用每渲变化；若无条件 setSubmitting(false)，会在"提交在途恰逢
  // 快照更新"时清锁，放大 F11 双击提交窗口。改为仅当 taskId 变化（新任务）才重置
  // 锁定——draft 击键 / 同任务引用变化都不再清锁。
  const submitLockTaskIdRef = useRef<string | null>(null);

  // 刷新后从 draft 恢复 part 进度；任务/snapshot 变化时重置提交锁。
  // F#7（🟠4）：已恢复值与当前 state 相同则跳过 setState，避免值未变的
  // parent 重渲（2s 轮询/其它 part）额外触发一轮 render。
  useEffect(() => {
    const restored = partInitialAnswers(draft);
    setAnswers((current) => {
      if (current[0] === restored[0] && current[1] === restored[1]) return current;
      return restored;
    });
    setSelectedTokens((current) => {
      const restoredTokens = restored[0]?.kind === "ordering" ? restored[0].orderedTokenIds : [];
      if (current.length === restoredTokens.length && restoredTokens.every((id, i) => current[i] === id)) {
        return current;
      }
      return restoredTokens;
    });
    // 仅当任务变化（taskId 变更 = 新任务初始态）才重置提交锁。
    if (submitLockTaskIdRef.current !== task.taskId) {
      submitLockTaskIdRef.current = task.taskId;
      setSubmitting(false);
    }
  }, [draft, task]);

  const handleSubmit = () => {
    if (submitting || !allDone) return;
    setSubmitting(true);
    onIntent({ kind: "submit_structured_bundle", partAnswers: answers.filter((answer): answer is PartAnswer => answer !== null) });
  };

  const persistDraft = (next: [PartAnswer | null, PartAnswer | null]) => {
    setAnswers(next);
    onDraftChange?.({
      kind: "structured_bundle",
      partAnswers: next.filter((answer): answer is PartAnswer => answer !== null),
    });
  };

  // wire 形状：labels 附加在 part 对象上（§12.3 只序列化 ids）。
  const orderingLabels = (orderingPart as unknown as { labels?: Record<string, string> }).labels ?? {};
  const relationLabels = (relationPart as unknown as { labels?: Record<string, string> }).labels ?? {};
  const allowedEdgeKinds = relationPart?.interaction.kind === "relation_canvas" ? relationPart.interaction.allowedEdgeKinds : [];

  const relationDone = answers[1]?.kind === "relation" && (answers[1].edges.length > 0);
  const orderingDone = (answers[0]?.kind === "ordering" && answers[0].orderedTokenIds.length === (orderingPart?.interaction.kind === "ordering" ? orderingPart.interaction.publicTokenIds.length : 0));
  const allDone = Boolean(orderingDone && relationDone);

  const edgeState = useMemo(() => {
    if (answers[1]?.kind !== "relation") return null;
    return answers[1].edges[0] ?? null;
  }, [answers]);

  // F#10（round3）：关系对的完整列表用 useMemo 缓存——原实现每渲对
  // relationNodeIds 双重 .map 重建 O(n²) 矩阵，属纯派生，缓存后只随
  // relationPart 变化（快照切换）重建。依赖 relationPart（稳定对象）而非
  // relationNodeIds 条件表达式，避免 lint 提示的每渲变化。
  const relationPairs = useMemo(() => {
    const nodeIds = relationPart?.interaction.kind === "relation_canvas"
      ? relationPart.interaction.publicNodeIds
      : [];
    if (nodeIds.length < 2) return [];
    const pairs: Array<{ fromNodeId: string; toNodeId: string }> = [];
    for (const fromNodeId of nodeIds) {
      for (const toNodeId of nodeIds) {
        if (fromNodeId === toNodeId) continue;
        pairs.push({ fromNodeId, toNodeId });
      }
    }
    return pairs;
  }, [relationPart]);

  if (!orderingPart || !relationPart) {
    return <p className="learning-run-renderer-note">这道组合题缺少完整结构，无法作答。</p>;
  }

  const tokenIds = orderingPart.interaction.kind === "ordering" ? orderingPart.interaction.publicTokenIds : [];

  const toggleToken = (tokenId: string) => {
    setSelectedTokens((current) => {
      const next = current.includes(tokenId)
        ? current.filter((id) => id !== tokenId)
        : [...current, tokenId];
      persistDraft([{ kind: "ordering", orderedTokenIds: next }, answers[1]]);
      return next;
    });
  };

  const pickEdge = (fromNodeId: string, toNodeId: string, edgeKind: string) => {
    persistDraft([answers[0], { kind: "relation", edges: [{ fromNodeId, toNodeId, edgeKind }] }]);
  };

  return (
    <section className="learning-run-structured-bundle" aria-label="组合作答">
      <header className="learning-run-bundle-step">
        <span>第 1 步 · 排序</span>
        <small>按你的理解排好顺序（点选即可，不要求拖拽）</small>
      </header>
      <div className="learning-run-token-list" role="group" aria-label="排序选项">
        {tokenIds.map((tokenId) => (
          <button
            key={tokenId}
            type="button"
            className={`learning-run-token-chip${selectedTokens.includes(tokenId) ? " is-selected" : ""}`}
            aria-pressed={selectedTokens.includes(tokenId)}
            onClick={() => toggleToken(tokenId)}
          >
            {orderingLabels[tokenId] ?? tokenId}
          </button>
        ))}
      </div>
      {selectedTokens.length > 0 && (
        <ol className="learning-run-token-order" aria-label="当前顺序">
          {selectedTokens.map((tokenId) => (
            <li key={tokenId}>{orderingLabels[tokenId] ?? tokenId}</li>
          ))}
        </ol>
      )}

      <header className="learning-run-bundle-step is-second">
        <span>第 2 步 · 关系</span>
        <small>选择一条引用支撑关系</small>
      </header>
      <div className="learning-run-relation-picker" role="group" aria-label="关系选择">
        {relationPairs.map(({ fromNodeId, toNodeId }) => {
          const isPicked = edgeState?.fromNodeId === fromNodeId && edgeState?.toNodeId === toNodeId;
          return (
            <div key={`${fromNodeId}:${toNodeId}`} className={`learning-run-relation-row${isPicked ? " is-picked" : ""}`}>
              <span className="learning-run-relation-nodes">
                <em>{relationLabels[fromNodeId] ?? fromNodeId}</em>
                <i aria-hidden="true">→</i>
                <em>{relationLabels[toNodeId] ?? toNodeId}</em>
              </span>
              <span className="learning-run-relation-kinds">
                {allowedEdgeKinds.map((edgeKind) => (
                  <button
                    key={edgeKind}
                    type="button"
                    aria-pressed={isPicked && edgeState?.edgeKind === edgeKind}
                    onClick={() => pickEdge(fromNodeId, toNodeId, edgeKind)}
                  >
                    {edgeKind}
                  </button>
                ))}
              </span>
            </div>
          );
        })}
      </div>

      <footer className="learning-run-bundle-actions">
        <p className="learning-run-bundle-note">
          只有两个部分都完成后才会一次性提交评估；单个部分只保存在草稿中。
        </p>
        <button
          type="button"
          className="learning-run-button is-primary"
          disabled={!allDone || submitting}
          onClick={handleSubmit}
        >
          {submitting ? "正在提交…" : "提交组合作答"}
        </button>
      </footer>
    </section>
  );
}
