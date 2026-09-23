import type { CSSProperties } from "react";
import {
  companionRunTraceExpired,
  nodeLabel,
  type CompanionRunTrace,
} from "../../app/companion-agent-nodes";
import type { CompanionProposalUiState } from "../../app/companion-chat-session";
import { CompanionProposalChoice } from "./CompanionProposalChoice";
import "./companion-run-trace.css";

const NODE_STATE_LABEL = {
  running: "进行中",
  succeeded: "已完成",
  waiting_confirmation: "等待选择",
  failed: "失败",
  cancelled: "已停止",
} as const;

type NodeState = keyof typeof NODE_STATE_LABEL;

function runStateLabel(status: string): string {
  switch (status) {
    case "accepted":
    case "running":
      return "进行中";
    case "waiting_for_confirmation":
      return "等待选择";
    case "succeeded":
      return "已完成";
    case "failed":
      return "失败";
    case "cancel_requested":
    case "cancelled":
      return "已停止";
    default:
      return "过程记录";
  }
}

function displayedNodeState(nodeState: NodeState, runStatus: string): NodeState {
  if (nodeState !== "running" && nodeState !== "waiting_confirmation") return nodeState;
  if (runStatus === "succeeded") return "succeeded";
  if (runStatus === "failed") return "failed";
  if (runStatus === "cancelled" || runStatus === "cancel_requested") return "cancelled";
  return nodeState;
}

function shouldOpenRunTrace(trace: CompanionRunTrace): boolean {
  return trace.summary.stepCount > 1
    || trace.summary.toolCallCount > 0
    || trace.summary.status === "waiting_for_confirmation"
    || trace.summary.status === "failed"
    || trace.nodes.some((node) => node.state === "waiting_confirmation" || node.state === "failed");
}

/** 实时回复与历史消息共用的真实执行轨迹。 */
export function CompanionRunTraceView({
  trace,
  defaultOpen = shouldOpenRunTrace(trace),
  proposalStates,
  onDecideProposal,
  onRetryProposal,
}: {
  readonly trace: CompanionRunTrace;
  readonly defaultOpen?: boolean;
  readonly proposalStates?: Readonly<Record<string, CompanionProposalUiState>>;
  readonly onDecideProposal?: (proposalId: string, decision: "confirm" | "reject") => void;
  readonly onRetryProposal?: (proposalId: string) => void;
}) {
  const expired = companionRunTraceExpired(trace);
  const stateLabel = runStateLabel(trace.summary.status);
  return (
    <details className="companion-history__trace" open={defaultOpen}>
      <summary>
        <span>执行过程</span>
        <small>{stateLabel} · {trace.summary.stepCount} 步 · {trace.summary.toolCallCount} 次工具</small>
      </summary>
      {expired ? (
        <p className="companion-history__trace-expired">过程记录已过期，只保留近期对话过程。</p>
      ) : (
        <ol>
          {trace.nodes.map((node, index) => {
            // assistant.status 没有单独的 completed 帧；历史摘要已经终态时仍照搬实时
            // running 会出现「整轮已完成 / 节点仍进行中」的矛盾。只对未决节点采用
            // 服务端真实 run 终态，已经明确成功/失败的工具节点保持原样。
            const state = displayedNodeState(node.state, trace.summary.status);
            return (
              <li
                key={node.key}
                data-state={state}
                style={{ "--trace-delay": Math.min(5, Math.max(0, trace.nodes.length - 1 - index)) } as CSSProperties}
              >
                <div>
                  <span>{nodeLabel(node)}</span>
                  {node.summary ? <small>{node.summary}</small> : null}
                  {node.proposalId && proposalStates && onDecideProposal ? (
                    <CompanionProposalChoice
                      proposalId={node.proposalId}
                      state={proposalStates[node.proposalId]}
                      context="history"
                      onDecide={(decision) => onDecideProposal(node.proposalId as string, decision)}
                      onRetry={onRetryProposal
                        ? () => { onRetryProposal(node.proposalId as string); }
                        : undefined}
                    />
                  ) : null}
                </div>
                <em>{NODE_STATE_LABEL[state]}</em>
              </li>
            );
          })}
        </ol>
      )}
    </details>
  );
}
