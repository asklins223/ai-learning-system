"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@/components/ui/icons";
import { useBodyScrollLock } from "@/lib/use-body-scroll-lock";
import { useFocusTrap } from "@/lib/use-focus-trap";
import { useModalIsolation } from "@/lib/use-modal-isolation";
import type {
  CandidateRevealContentV2,
  CandidateReviewItemV2,
  CandidateSetSummaryV2,
} from "./contracts/ui-contracts";

/** 后端动作会签（R7）：生产页面传入后，keep/reject/edit/merge 走真实 V2 API。 */
export interface CandidateActionRequestV2Local {
  type: "keep" | "reject" | "edit" | "merge" | "undo_reject";
  candidateId: string;
  expectedRevision: number;
  expectedRevisionHash: string;
  candidateIds?: string[];
  patch?: {
    objectiveStatement?: string;
    front?: { prompt: string };
  };
}

export interface CandidateReviewBackend {
  /** 提交一个真实 candidate action；edit/merge 由服务端置 qualityState=checking。 */
  submitAction: (request: CandidateActionRequestV2Local) => Promise<void>;
  /** 重新拉取候选最新状态（用于 resolve 重新检查后的真实 qualityState）。 */
  refresh: () => Promise<CandidateReviewItemV2[]>;
}

export interface CandidateReviewProps {
  summary: CandidateSetSummaryV2;
  initialCandidates: CandidateReviewItemV2[];
  onReveal: (candidate: CandidateReviewItemV2) => Promise<CandidateRevealContentV2>;
  onActivate?: (selected: CandidateReviewItemV2[], hasExposure: boolean) => void;
  /** 真实后端会签；缺省时保持本地预览行为（Legacy demo Lab 使用）。 */
  backend?: CandidateReviewBackend;
}

type RecheckReason = "edit" | "merge" | "redesign";

function canMergeCandidates(source: CandidateReviewItemV2, target: CandidateReviewItemV2) {
  return source.candidateId !== target.candidateId
    && source.reviewState === "ready"
    && target.reviewState === "ready"
    && Boolean(source.mergeEligibility?.semanticGroupId)
    && source.mergeEligibility?.semanticGroupId === target.mergeEligibility?.semanticGroupId;
}

function CandidateEditDialog({
  candidate,
  onClose,
  onSave,
}: {
  candidate: CandidateReviewItemV2;
  onClose: () => void;
  onSave: (objective: string, prompt: string) => void;
}) {
  const [objective, setObjective] = useState(candidate.objective);
  const [prompt, setPrompt] = useState(candidate.prompt);
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const objectiveId = useId();
  const promptId = useId();

  useModalIsolation(dialogRef, true);
  useFocusTrap(dialogRef, true);
  useBodyScrollLock(true);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return createPortal(
    <div className="candidate-edit-overlay" role="presentation" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        className="candidate-edit-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <p>调整候选的回忆目标</p>
            <h2 id={titleId}>调整候选的回忆目标</h2>
            <span>保存后候选会进入服务端重新检查，通过前不能启用。</span>
          </div>
          <button type="button" aria-label="关闭候选编辑" onClick={onClose}>
            <Icon.Close />
          </button>
        </header>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onSave(objective.trim(), prompt.trim());
          }}
        >
          <label htmlFor={objectiveId}>
            <span>学习目标</span>
            <input
              id={objectiveId}
              value={objective}
              maxLength={120}
              required
              onChange={(event) => setObjective(event.target.value)}
            />
          </label>
          <label htmlFor={promptId}>
            <span>正面问题</span>
            <textarea
              id={promptId}
              value={prompt}
              rows={5}
              maxLength={360}
              required
              onChange={(event) => setPrompt(event.target.value)}
            />
          </label>
          <p className="candidate-edit-dialog__note">
            <Icon.Lock />答案与依据不在编辑表单中，也不会因打开编辑器而提前进入页面。
          </p>
          <footer>
            <button type="button" className="card-v2-button card-v2-button--quiet" onClick={onClose}>取消</button>
            <button
              type="submit"
              className="card-v2-button card-v2-button--primary"
              disabled={!objective.trim() || !prompt.trim()}
            >
              <Icon.Check />保存改动并检查
            </button>
          </footer>
        </form>
      </div>
    </div>,
    document.body,
  );
}

export function CandidateReview({
  summary,
  initialCandidates,
  onReveal,
  onActivate,
  backend,
}: CandidateReviewProps) {
  const [candidates, setCandidates] = useState(initialCandidates);
  const [reveals, setReveals] = useState<Record<string, CandidateRevealContentV2>>({});
  const [revealingId, setRevealingId] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [mergeSourceId, setMergeSourceId] = useState<string | null>(null);
  const [mergeTargetIds, setMergeTargetIds] = useState<string[]>([]);
  const [recheckReasons, setRecheckReasons] = useState<Record<string, RecheckReason>>({});
  const [mergedInto, setMergedInto] = useState<Record<string, string>>({});
  const selectedBeforeReject = useRef<Record<string, boolean>>({});

  const selected = useMemo(
    () => candidates.filter((candidate) => candidate.selected && candidate.reviewState === "ready"),
    [candidates],
  );
  const editingCandidate = candidates.find((candidate) => candidate.candidateId === editingId) ?? null;
  const mergeSource = candidates.find((candidate) => candidate.candidateId === mergeSourceId) ?? null;
  // FN7：排他合并目标候选预计算——避免渲染体内对全数组重复 filter/查找。
  const mergeTargetCandidates = useMemo(
    () => candidates.filter((candidate) => candidate.candidateId !== mergeSourceId),
    [candidates, mergeSourceId],
  );
  const hasExposure = Object.keys(reveals).length > 0;
  const hasRechecking = candidates.some((candidate) => candidate.reviewState === "rechecking");

  function replaceCandidate(candidateId: string, update: (candidate: CandidateReviewItemV2) => CandidateReviewItemV2) {
    setCandidates((current) => current.map((candidate) => (
      candidate.candidateId === candidateId ? update(candidate) : candidate
    )));
  }

  function clearReveal(candidateIds: string[]) {
    const ids = new Set(candidateIds);
    setReveals((current) => Object.fromEntries(
      Object.entries(current).filter(([candidateId]) => !ids.has(candidateId)),
    ));
  }

  function toggleCandidate(candidateId: string) {
    replaceCandidate(candidateId, (candidate) => ({ ...candidate, selected: !candidate.selected }));
  }

  async function reveal(candidate: CandidateReviewItemV2) {
    if (reveals[candidate.candidateId] || revealingId || candidate.reviewState !== "ready") return;
    setRevealingId(candidate.candidateId);
    setNotice(null);
    try {
      const content = await onReveal(candidate);
      setReveals((current) => ({ ...current, [candidate.candidateId]: content }));
      setNotice("答案已显示，并已记为本次预习。立即开始时将先进入练习模式。");
    } finally {
      setRevealingId(null);
    }
  }

  function reject(candidate: CandidateReviewItemV2) {
    selectedBeforeReject.current[candidate.candidateId] = candidate.selected;
    replaceCandidate(candidate.candidateId, (item) => ({ ...item, selected: false, reviewState: "rejected" }));
    setNotice("已移出待启用集合；可撤销。");
    if (backend) {
      void backend
        .submitAction({
          type: "reject",
          candidateId: candidate.candidateId,
          expectedRevision: candidate.revision,
          expectedRevisionHash: "",
        })
        .catch(() => {
          setNotice("不保留提交失败，请稍后重试或撤销。");
        });
    }
  }

  function undoReject(candidateId: string) {
    replaceCandidate(candidateId, (item) => ({
      ...item,
      selected: selectedBeforeReject.current[candidateId] ?? true,
      reviewState: "ready",
    }));
    setMergedInto((current) => {
      const next = { ...current };
      delete next[candidateId];
      return next;
    });
    setNotice("已撤销“不保留”，候选恢复到审核队列。");
    if (backend) {
      const item = candidates.find((c) => c.candidateId === candidateId);
      if (item) {
        void backend
          .submitAction({
            type: "undo_reject",
            candidateId,
            expectedRevision: item.revision,
            expectedRevisionHash: "",
          })
          .catch(() => setNotice("撤销提交失败，请稍后重试。"));
      }
    }
  }

  function beginRecheck(candidateId: string, reason: RecheckReason) {
    replaceCandidate(candidateId, (candidate) => ({ ...candidate, selected: false, reviewState: "rechecking" }));
    setRecheckReasons((current) => ({ ...current, [candidateId]: reason }));
    setMergeSourceId(null);
    setMergeTargetIds([]);
  }

  function finishRecheck(candidateId: string) {
    if (backend) {
      // 真实后端：重新拉取服务端对这条候选的最新qualityState。
      void backend
        .refresh()
        .then((latest) => {
          setCandidates(latest);
          const found = latest.find((c) => c.candidateId === candidateId);
          setNotice(
            found?.reviewState === "ready"
              ? "服务端已完成重新检查，候选回到待启用队列。"
              : found?.reviewState === "rechecking"
                ? "服务端仍在重新检查，暂时不能启用。"
                : "状态已刷新。",
          );
        })
        .catch(() => setNotice("刷新候选状态失败，请稍后重试。"));
      return;
    }
    replaceCandidate(candidateId, (candidate) => ({ ...candidate, selected: true, reviewState: "ready" }));
    setRecheckReasons((current) => {
      const next = { ...current };
      delete next[candidateId];
      return next;
    });
    setNotice("本地检查已完成。正式版本仍需 V2 服务端复核成功后才能启用。");
  }

  function saveEdit(candidateId: string, objective: string, prompt: string) {
    replaceCandidate(candidateId, (candidate) => ({
      ...candidate,
      revision: candidate.revision + 1,
      objective,
      prompt,
    }));
    clearReveal([candidateId]);
    setEditingId(null);
    beginRecheck(candidateId, "edit");
    setNotice("改动已保存，候选暂时不可启用；正在向服务端提交重新检查。");
    if (backend) {
      const item = candidates.find((c) => c.candidateId === candidateId);
      if (item) {
        void backend
          .submitAction({
            type: "edit",
            candidateId,
            expectedRevision: item.revision,
            expectedRevisionHash: "",
            patch: { objectiveStatement: objective, front: { prompt } },
          })
          .catch(() => setNotice("编辑提交失败，请稍后重试。"));
      }
    }
  }

  function toggleMergeTarget(candidateId: string) {
    setMergeTargetIds((current) => current.includes(candidateId)
      ? current.filter((id) => id !== candidateId)
      : [...current, candidateId]);
  }

  function previewMerge() {
    if (!mergeSource || mergeTargetIds.length === 0) return;
    const mergeTargetSet = new Set(mergeTargetIds);
    const targets = candidates.filter((candidate) => mergeTargetSet.has(candidate.candidateId));
    if (targets.some((target) => !canMergeCandidates(mergeSource, target))) return;

    const affectedIds = [mergeSource.candidateId, ...mergeTargetIds];
    const mergedPrompt = `${mergeSource.prompt}\n并请一并回答：${targets.map((target) => target.prompt).join("；")}`;
    replaceCandidate(mergeSource.candidateId, (candidate) => ({
      ...candidate,
      revision: candidate.revision + 1,
      prompt: mergedPrompt,
      reason: `${candidate.reason}（已合并 ${targets.length} 个同目标候选。）`,
    }));
    setCandidates((current) => current.map((candidate) => (
      mergeTargetIds.includes(candidate.candidateId)
        ? { ...candidate, selected: false, reviewState: "rejected" }
        : candidate
    )));
    setMergedInto((current) => ({
      ...current,
      ...Object.fromEntries(mergeTargetIds.map((candidateId) => [candidateId, mergeSource.candidateId])),
    }));
    clearReveal(affectedIds);
    beginRecheck(mergeSource.candidateId, "merge");
    setNotice("已提交合并；候选进入重新检查，通过前不能启用。");
    if (backend) {
      void backend
        .submitAction({
          type: "merge",
          candidateId: mergeSource.candidateId,
          expectedRevision: mergeSource.revision,
          expectedRevisionHash: "",
          candidateIds: affectedIds,
          patch: { front: { prompt: mergedPrompt } },
        })
        .catch(() => setNotice("合并提交失败，请稍后重试。"));
    }
  }

  return (
    <section className="candidate-review" aria-labelledby="candidate-review-title">
      <header className="candidate-review__header">
        <div>
          <p className="candidate-review__eyebrow">候选学习卡</p>
          <h2 id="candidate-review-title">
            建议启用 <strong>{selected.length}</strong> 张
          </h2>
          <p>{summary.atomCount} 条信息被整理为 {summary.candidateCount} 个可练目标，没有为了覆盖原文而逐条制卡。</p>
        </div>
        <div className="candidate-review__burden">
          <span>单轮预计</span>
          <strong>{Math.max(1, Math.round(summary.estimatedReviewSeconds / 60))} 分钟</strong>
          <small>启用后仍不会创建复习计划</small>
        </div>
      </header>

      <div className="candidate-review__sourcebar">
        <span><Icon.FileText />{summary.sourceLabel}</span>
        <span>版本 v{summary.sourceVersion}</span>
        <span>{summary.mergedCount} 条已合并</span>
        <span>{summary.supportOnlyCount} 条仅作支持</span>
        {backend
          ? <b>已接通 V2 服务 · 操作即时提交</b>
          : <b>开发预览 · 操作只保存在本页</b>}
      </div>

      <div className="candidate-review__list">
        {candidates.map((candidate, index) => {
          const revealContent = reveals[candidate.candidateId];
          const recheckReason = recheckReasons[candidate.candidateId];
          const isMergeSource = mergeSourceId === candidate.candidateId;
          return (
            <article
              className="candidate-review-card"
              data-selected={candidate.selected || undefined}
              data-state={candidate.reviewState}
              key={candidate.candidateId}
            >
              <header className="candidate-review-card__topline">
                <label className="candidate-review-card__select">
                  <input
                    type="checkbox"
                    checked={candidate.selected}
                    disabled={candidate.reviewState !== "ready"}
                    onChange={() => toggleCandidate(candidate.candidateId)}
                  />
                  <span aria-hidden="true"><Icon.Check /></span>
                  <b>候选 {String(index + 1).padStart(2, "0")}</b>
                </label>
                <div className="candidate-review-card__tags">
                  {candidate.reviewState === "rechecking" && <span className="is-rechecking">重新检查中</span>}
                  {candidate.reviewState === "rejected" && <span className="is-rejected">不保留</span>}
                  <span>{candidate.knowledgeForm}</span>
                  <span>{candidate.strategyLabel}</span>
                  <span>约 {candidate.estimatedSeconds} 秒</span>
                </div>
              </header>

              <div className="candidate-review-card__body">
                <p className="candidate-review-card__objective">学习目标 · {candidate.objective}</p>
                <h3>{candidate.prompt}</h3>
                <div className="candidate-review-card__reason">
                  <Icon.Target aria-hidden="true" />
                  <p><strong>为什么值得做成卡</strong>{candidate.reason}</p>
                </div>

                {candidate.reviewState === "rechecking" && (
                  <div className="candidate-review-card__rechecking" role="status">
                    <Icon.Refresh />
                    <div>
                      <strong>
                        {recheckReason === "redesign" ? "重新设计状态预览" : "候选正在重新检查"}
                      </strong>
                      <p>
                        {recheckReason === "redesign"
                          ? "这里仅模拟候选离开可启用队列；没有请求或伪造新的候选内容。"
                          : "改动只在当前页面。正式版本会等待 V2 服务端重新核对答案、依据与重复项。"}
                      </p>
                    </div>
                    <button type="button" onClick={() => finishRecheck(candidate.candidateId)}>
                      {recheckReason === "redesign" ? "退出状态预览" : "标记本地检查完成"}
                    </button>
                  </div>
                )}

                {candidate.reviewState === "rejected" && (
                  <div className="candidate-review-card__rejected-note" role="status">
                    <Icon.Trash />
                    <span>{mergedInto[candidate.candidateId] ? "已并入另一个同目标候选（本地预览）" : "已移出候选，不会计入启用数量"}</span>
                  </div>
                )}

                {candidate.reviewState === "ready" && (revealContent ? (
                  <section className="candidate-review-card__reveal" aria-label="已揭示答案">
                    <p className="candidate-review-card__reveal-label">
                      <Icon.Warn aria-hidden="true" /> 已预习答案
                    </p>
                    <h4>参考答案</h4>
                    <p>{revealContent.answer}</p>
                    <h4>理解线索</h4>
                    <p>{revealContent.explanation}</p>
                    <details>
                      <summary>查看原文依据</summary>
                      <blockquote>{revealContent.evidencePreview}</blockquote>
                    </details>
                  </section>
                ) : (
                  <button
                    type="button"
                    className="candidate-review-card__reveal-button"
                    disabled={revealingId !== null}
                    onClick={() => void reveal(candidate)}
                  >
                    <Icon.Open aria-hidden="true" />
                    {revealingId === candidate.candidateId ? "正在记录并打开…" : "查看答案与依据"}
                    <small>查看后会标记为已预习</small>
                  </button>
                ))}
              </div>

              <footer className="candidate-review-card__footer">
                {candidate.reviewState === "rejected" ? (
                  <button type="button" className="candidate-review-card__undo" onClick={() => undoReject(candidate.candidateId)}>
                    <Icon.Refresh />撤销不保留
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      disabled={candidate.reviewState !== "ready"}
                      onClick={() => {
                        clearReveal([candidate.candidateId]);
                        beginRecheck(candidate.candidateId, "redesign");
                        setNotice("已进入重新设计状态预览；接口接通后才会提交真实请求。");
                      }}
                    >
                      <Icon.Refresh />重新设计
                    </button>
                    <button
                      type="button"
                      disabled={candidate.reviewState !== "ready"}
                      onClick={() => setEditingId(candidate.candidateId)}
                    >
                      <Icon.Highlighter />编辑
                    </button>
                    <button
                      type="button"
                      aria-expanded={isMergeSource}
                      disabled={candidate.reviewState !== "ready"}
                      onClick={() => {
                        setMergeSourceId(isMergeSource ? null : candidate.candidateId);
                        setMergeTargetIds([]);
                      }}
                    >
                      <Icon.Link />合并
                    </button>
                    <button
                      type="button"
                      className="candidate-review-card__remove"
                      disabled={candidate.reviewState !== "ready"}
                      onClick={() => reject(candidate)}
                    >
                      <Icon.Trash />不保留
                    </button>
                  </>
                )}
              </footer>

              {isMergeSource && mergeSource && (
                <section className="candidate-review-card__merge" aria-label={`合并候选 ${index + 1}`}>
                  <header>
                    <div>
                      <strong>选择要并入的同目标候选</strong>
                      <span>只有服务端标记为同一语义组的候选才能选择。</span>
                    </div>
                    <button type="button" aria-label="关闭合并选择" onClick={() => setMergeSourceId(null)}><Icon.Close /></button>
                  </header>
                  <div className="candidate-review-card__merge-options">
                    {mergeTargetCandidates.map((target) => {
                      const compatible = canMergeCandidates(candidate, target);
                      return (
                        <label key={target.candidateId} data-compatible={compatible || undefined}>
                          <input
                            type="checkbox"
                            checked={mergeTargetIds.includes(target.candidateId)}
                            disabled={!compatible}
                            onChange={() => toggleMergeTarget(target.candidateId)}
                          />
                          <span>
                            <strong>{target.objective}</strong>
                            <small>{compatible
                              ? target.mergeEligibility?.rationale ?? "同一语义目标，可以加入合并预览"
                              : "学习目标不同，不能直接合并"}</small>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                  <footer>
                    <span>{mergeTargetIds.length > 0 ? `已选择 ${mergeTargetIds.length} 个候选` : "还没有可合并的选择"}</span>
                    <button
                      type="button"
                      className="card-v2-button card-v2-button--secondary"
                      disabled={mergeTargetIds.length === 0}
                      onClick={previewMerge}
                    >
                      {backend ? "提交合并并重新检查" : "生成本地合并预览"}
                    </button>
                  </footer>
                </section>
              )}
            </article>
          );
        })}
      </div>

      <button
        type="button"
        className="candidate-review__decisions-toggle"
        aria-expanded={advancedOpen}
        onClick={() => setAdvancedOpen((open) => !open)}
      >
        <span><Icon.Timeline />查看未单独制卡的内容</span>
        <small>{summary.supportOnlyCount} 条仅作答案支持 · {summary.mergedCount} 条已合并</small>
        <Icon.Chevron />
      </button>
      {advancedOpen && (
        <div className="candidate-review__decisions">
          <p><strong>仅作答案支持</strong>“各层数据单元名称”没有独立制卡，已放入职责匹配的解释中。</p>
          <p><strong>已合并</strong>“网络层负责寻址”和“网络层负责路由”共同支撑一个匹配目标。</p>
          <p><strong>未纳入</strong>装饰标题与重复段落不会增加复习负担。</p>
        </div>
      )}

      <div className="candidate-review__dock">
        <div>
          <span>{selected.length > 0 ? `已选择 ${selected.length} 张` : "没有选择候选"}</span>
          <strong>
            {hasRechecking
              ? "有候选正在重新检查，暂时不能启用"
              : hasExposure
                ? "已看过答案：启用后可先练习，之后再验证"
                : "未看答案：启用后可直接开始首次验证"}
          </strong>
        </div>
        <button
          type="button"
          className="card-v2-button card-v2-button--primary"
          disabled={selected.length === 0 || hasRechecking}
          onClick={() => onActivate?.(selected, hasExposure)}
          title={backend ? "提交启用请求" : "开发预览：接口接通后才会提交启用请求"}
        >
          <Icon.Check />{hasRechecking ? "等待重新检查" : `启用 ${selected.length} 张学习卡`}
        </button>
      </div>
      {notice && <p className="candidate-review__notice" role="status">{notice}</p>}

      {editingCandidate && (
        <CandidateEditDialog
          key={editingCandidate.candidateId}
          candidate={editingCandidate}
          onClose={() => setEditingId(null)}
          onSave={(objective, prompt) => saveEdit(editingCandidate.candidateId, objective, prompt)}
        />
      )}
    </section>
  );
}
