import { Loader2 } from "lucide-react";
import type { CompanionProposalUiState } from "../../app/companion-chat-session";
import "./companion-proposal-choice.css";

const PROPOSAL_STATUS_LABEL: Record<
  Extract<CompanionProposalUiState, { phase: "ready" }>["proposal"]["status"],
  string
> = {
  pending: "等待你的选择",
  accepted: "已确认",
  executing: "正在执行",
  succeeded: "已完成",
  rejected: "已跳过",
  failed: "执行失败",
  expired: "已过期",
};

export interface CompanionProposalChoiceProps {
  readonly proposalId: string;
  readonly state: CompanionProposalUiState | undefined;
  readonly context: "bubble" | "history";
  readonly onDecide: (decision: "confirm" | "reject") => void;
}

/**
 * Agent 需要用户作决定时的唯一交互组件。
 *
 * 气泡与历史记录共用这一个实例形状，也共用会话层的 proposal 状态；这里不复制状态、
 * 不猜执行结果。历史中的卡片因此能在另一个入口作出决定后同步变成终态留痕。
 */
export function CompanionProposalChoice({
  proposalId,
  state,
  context,
  onDecide,
}: CompanionProposalChoiceProps) {
  if (!state || state.phase === "loading") {
    return (
      <section
        className="companion-choice-card companion-choice-card--loading"
        data-context={context}
        aria-label="正在读取需要你选择的建议"
        aria-busy="true"
      >
        <Loader2 className="companion-choice-card__spinner" size={16} aria-hidden="true" />
        <span>正在准备选项…</span>
      </section>
    );
  }

  if (state.phase === "error") {
    return (
      <section
        className="companion-choice-card companion-choice-card--error"
        data-context={context}
        role="status"
        aria-label="这个选择暂时无法读取"
      >
        <strong>这个选择暂时无法读取</strong>
        <span>{state.message}</span>
      </section>
    );
  }

  const { proposal, deciding, error } = state;
  const pending = proposal.status === "pending";
  const statusLabel = PROPOSAL_STATUS_LABEL[proposal.status];

  return (
    <section
      className="companion-choice-card"
      data-context={context}
      data-status={proposal.status}
      data-proposal-id={proposalId}
      role="group"
      aria-label={`${proposal.title}：${statusLabel}`}
      aria-busy={Boolean(deciding)}
    >
      <header>
        <span>{pending ? "需要你的选择" : "选择结果"}</span>
        <small>{statusLabel}</small>
      </header>
      <strong className="companion-choice-card__title">{proposal.title}</strong>
      <dl>
        <div><dt>目标</dt><dd>{proposal.targetSummary}</dd></div>
        <div><dt>影响</dt><dd>{proposal.impactSummary}</dd></div>
      </dl>
      {pending ? (
        <div className="companion-choice-card__actions">
          <button
            type="button"
            className="companion-choice-card__confirm"
            disabled={Boolean(deciding)}
            onClick={() => onDecide("confirm")}
          >
            {deciding === "confirm" ? "正在确认…" : "确认执行"}
          </button>
          <button
            type="button"
            disabled={Boolean(deciding)}
            onClick={() => onDecide("reject")}
          >
            {deciding === "reject" ? "正在处理…" : "暂不执行"}
          </button>
        </div>
      ) : null}
      {error ? <p className="companion-choice-card__error" role="status">{error}</p> : null}
    </section>
  );
}
