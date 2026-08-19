/**
 * Plan 23 TP-11..TP-17：Understanding Graph V3（objective-native）。
 *
 * - 数据：只消费 /v3/understanding/topology（UnderstandingTopologySnapshotV3）；
 *   节点只允许 source/note/objective/evidence（guard 断言，无 card/key_point）；
 * - 视觉语义：四类节点形状/颜色/图例可区分，状态不只靠颜色（§36.4）；
 * - 侧栏：选中 Objective 显示来源、个人状态与 typed action（TP-14/15）；
 * - loading/empty/degraded：0 Objective 仍展示 Note；缺 origin 有修复提示（TP-17）。
 */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type {
  UnderstandingTopologySnapshotV3,
  UnderstandingNodeProjectionV3,
  ObjectiveNodeProjectionV3,
  UnderstandingEdgeProjectionV3,
} from "@ailearn/shared";
import { learningObjectiveApi } from "@/lib/learning-objective-api";
import { assertNoCardOrKeyPointNode } from "@ailearn/shared";
import { ObjectivePrimaryAction } from "@/features/learning-objective/ObjectivePrimaryAction";
import { ObjectiveStatusChip, type ObjectiveChipState } from "@/features/learning-objective/ObjectiveStatusChip";
import { ObjectiveSkeleton, ObjectiveError } from "@/features/learning-objective/ObjectiveStatePrimitives";
import { objectiveActionHref } from "@/features/learning-objective/action-navigation";

const COL_X: Record<"source" | "note" | "objective" | "evidence", number> = {
  source: 120,
  note: 320,
  objective: 640,
  evidence: 920,
};

const NODE_H = 54;
const NODE_GAP = 18;

function nodeKindOf(node: UnderstandingNodeProjectionV3): "source" | "note" | "objective" | "evidence" {
  return node.nodeRef.kind;
}

function nodeLabel(node: UnderstandingNodeProjectionV3): string {
  if (node.nodeRef.kind === "evidence") {
    return (node as Extract<UnderstandingNodeProjectionV3, { nodeRef: { kind: "evidence" } }>).supportSummary;
  }
  return (node as { label: string }).label;
}

function chipStateOf(node: ObjectiveNodeProjectionV3): ObjectiveChipState {
  // 优先使用 lifecycle 终态
  if (node.lifecycle === "archived") return "archived";
  if (node.lifecycle === "superseded") return "superseded";
  // 服务端已综合所有状态计算了 personal.state 和 primaryAction（§7.5）；
  // 直接映射，不自行推断。
  // 与 objective-state.ts 的 objectiveChipStateFromSurface 保持一致，
  // 避免同一状态在不同页面产生不同 chip 颜色（§36.2）。
  switch (node.personal.primaryAction.kind) {
    case "resume_run": return "run";
    case "create_review_run": return "due";
    case "wait_for_initial_validation": return "ready";
    // practice_only：用户已 Reveal 但尚未通过正式验证，应提示练习（due），
    // 不是 stable（§7.4：Reveal 后主行动变为 practice_only，需练习）。
    case "practice_only": return "due";
    case "view_successor": return "superseded";
    case "refresh": return "outdated";
    // none：lifecycle=active 且无可用行动时可能是 missing_origin 修复中，
    // 不应误显为 archived（只有 lifecycle=archived 才是 archived）。
    case "none":
      return "ready";
    case "create_run":
      return node.personal.lastCanonicalEventId ? "stable" : "ready";
    default: return "ready";
  }
}

interface LayoutNode {
  key: string;
  kind: "source" | "note" | "objective" | "evidence";
  x: number;
  y: number;
  node: UnderstandingNodeProjectionV3;
}

export function UnderstandingGraphV3(): JSX.Element {
  const router = useRouter();
  const [snapshot, setSnapshot] = useState<UnderstandingTopologySnapshotV3 | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const offset = useRef({ x: 40, y: 24 });

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await learningObjectiveApi.getTopology();
      // TP-13 guard：V2 卡不得产生 Card/alias 双节点
      const { violations } = assertNoCardOrKeyPointNode(data.nodes);
      if (violations.length > 0) {
        setError("星图数据包含非法节点（card/key_point），请刷新重试。");
        return;
      }
      setSnapshot(data);
    } catch {
      setError("理解星图暂时不可用");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 分层布局：source/note 左列、objective 中列、evidence 右列
  const layout = useMemo<LayoutNode[]>(() => {
    if (!snapshot) return [];
    const columns: Record<string, LayoutNode[]> = { source: [], note: [], objective: [], evidence: [] };
    for (const node of snapshot.nodes) {
      const kind = nodeKindOf(node);
      columns[kind].push({
        key: kind + ":" + nodeRefId(node),
        kind,
        x: COL_X[kind],
        y: 0,
        node,
      });
    }
    const result: LayoutNode[] = [];
    for (const kind of ["source", "note", "objective", "evidence"] as const) {
      const list = columns[kind];
      list.forEach((item, index) => {
        item.y = 24 + index * (NODE_H + NODE_GAP);
      });
      result.push(...list);
    }
    return result;
  }, [snapshot]);

  const layoutByKey = useMemo(() => new Map(layout.map((l) => [l.key, l])), [layout]);
  const selected = selectedKey ? layoutByKey.get(selectedKey) ?? null : null;

  const width = 1080;
  const height = Math.max(320, 24 + Math.max(
    layout.filter((l) => l.kind === "objective").length,
    layout.filter((l) => l.kind === "note").length,
    layout.filter((l) => l.kind === "source").length,
    layout.filter((l) => l.kind === "evidence").length,
  ) * (NODE_H + NODE_GAP) + NODE_H + 24);

  const edgeLine = (edge: UnderstandingEdgeProjectionV3): { x1: number; y1: number; x2: number; y2: number } | null => {
    const from = layoutByKey.get(edge.from.kind + ":" + edge.from.id);
    const to = layoutByKey.get(edge.to.kind + ":" + edge.to.id);
    if (!from || !to) return null;
    return {
      x1: from.x + 60,
      y1: from.y + NODE_H / 2,
      x2: to.x - 60,
      y2: to.y + NODE_H / 2,
    };
  };

  const onWheel = useCallback((event: React.WheelEvent) => {
    const next = Math.min(2.2, Math.max(0.5, zoom * (event.deltaY < 0 ? 1.1 : 0.9)));
    setZoom(next);
  }, [zoom]);

  if (error && !snapshot) {
    return <ObjectiveError message={error} retryable onRetry={() => void load()} />;
  }
  if (!snapshot) {
    return <ObjectiveSkeleton rows={6} />;
  }

  const objectiveNodes = layout.filter((l) => l.kind === "objective");
  const noteCount = snapshot.nodes.filter((n) => n.nodeRef.kind === "note").length;

  return (
    <div className="graph-v3">
      <div className="graph-v3-toolbar">
        <div className="graph-v3-legend" aria-label="图例">
          <span className="graph-v3-legend-item" data-kind="source"><i aria-hidden="true" />来源</span>
          <span className="graph-v3-legend-item" data-kind="note"><i aria-hidden="true" />笔记</span>
          <span className="graph-v3-legend-item" data-kind="objective"><i aria-hidden="true" />学习目标</span>
          <span className="graph-v3-legend-item" data-kind="evidence"><i aria-hidden="true" />证据</span>
        </div>
        <div className="graph-v3-zoom">
          <button type="button" onClick={() => setZoom(Math.min(2.2, zoom * 1.2))} aria-label="放大">＋</button>
          <span>{Math.round(zoom * 100)}%</span>
          <button type="button" onClick={() => setZoom(Math.max(0.5, zoom / 1.2))} aria-label="缩小">－</button>
        </div>
      </div>

      {error && (
        <div className="graph-v3-inline-error" role="status">
          {error} <button type="button" onClick={() => void load()}>重试</button>
        </div>
      )}

      {snapshot.integrity.missingOriginObjectiveIds.length > 0 && (
        <div className="graph-v3-integrity" role="status">
          {snapshot.integrity.missingOriginObjectiveIds.length} 个学习目标缺少可证明的来源，将在修复后显示血缘。
        </div>
      )}

      {objectiveNodes.length === 0 && noteCount === 0 ? (
        <div className="graph-v3-empty">
          <p>还没有可展示的知识内容。</p>
          <Link href="/sources" className="objective-primary-action">先去收一份材料</Link>
        </div>
      ) : objectiveNodes.length === 0 ? (
        <div className="graph-v3-empty">
          <p>已有笔记，但还没有学习目标。</p>
          <Link href="/notes" className="objective-primary-action">从笔记生成</Link>
        </div>
      ) : (
        <div className="graph-v3-stage" onWheel={onWheel}>
          <svg
            width="100%"
            viewBox={-offset.current.x + " " + (-offset.current.y) + " " + (width / zoom) + " " + (height / zoom)}
            role="img"
            aria-label="理解星图：来源、笔记、学习目标与证据"
            className="graph-v3-svg"
          >
            <g>
              {snapshot.edges.map((edge) => {
                const line = edgeLine(edge);
                if (!line) return null;
                const dash = edge.kind === "supersedes";
                return (
                  <line
                    key={edge.edgeId}
                    x1={line.x1} y1={line.y1} x2={line.x2} y2={line.y2}
                    className={"graph-v3-edge graph-v3-edge--" + edge.kind}
                    strokeDasharray={dash ? "6 4" : undefined}
                  />
                );
              })}
            </g>
            <g>
              {layout.map((item) => (
                <g
                  key={item.key}
                  transform={"translate(" + item.x + " " + item.y + ")"}
                  className={
                    "graph-v3-node graph-v3-node--" + item.kind +
                    (selectedKey === item.key ? " graph-v3-node--selected" : "")
                  }
                  onClick={() => setSelectedKey(item.key)}
                  role="button"
                  tabIndex={0}
                  aria-label={nodeLabel(item.node)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setSelectedKey(item.key);
                    }
                  }}
                >
                  <rect width={120} height={NODE_H} rx={14} />
                  <text x={60} y={24} textAnchor="middle" className="graph-v3-node-label">
                    {nodeLabel(item.node).slice(0, 12)}
                  </text>
                  <text x={60} y={42} textAnchor="middle" className="graph-v3-node-sub">
                    {item.kind}
                  </text>
                </g>
              ))}
            </g>
          </svg>

          {selected && selected.kind === "objective" && (
            <aside className="graph-v3-sidepanel" aria-label="学习目标详情">
              <ObjectiveSidePanel
                node={selected.node as ObjectiveNodeProjectionV3}
                onClose={() => setSelectedKey(null)}
                onAction={(action) => {
                  const href = objectiveActionHref(action, "/graph");
                  if (href) router.push(href);
                }}
              />
            </aside>
          )}
        </div>
      )}
    </div>
  );
}

function nodeRefId(node: UnderstandingNodeProjectionV3): string {
  switch (node.nodeRef.kind) {
    case "source": return node.nodeRef.sourceId;
    case "note": return node.nodeRef.noteId;
    case "objective": return node.nodeRef.objectiveId;
    case "evidence": return node.nodeRef.evidenceSnapshotId;
  }
}

/** TP-14：Objective 侧栏（来源/个人状态/typed action；不展示答案）。 */
function ObjectiveSidePanel(props: {
  node: ObjectiveNodeProjectionV3;
  onClose: () => void;
  onAction: (action: ObjectiveNodeProjectionV3["personal"]["primaryAction"]) => void;
}): JSX.Element {
  const { node } = props;
  // 详情页路由 /learning-cards/:cardId 支持 route resolution（objectiveId 可解析）。
  // 不使用 /learning-objectives/ 路径（该路由不存在）。
  const detailHref = "/learning-cards/" + node.nodeRef.objectiveId;
  return (
    <div className="graph-v3-sidepanel-body">
      <header>
        <h3>{node.label}</h3>
        <button type="button" onClick={props.onClose} aria-label="关闭详情">×</button>
      </header>
      <ObjectiveStatusChip state={chipStateOf(node)} />
      <p className="graph-v3-sidepanel-summary">{node.publicSummary}</p>
      <dl className="graph-v3-sidepanel-state">
        <div><dt>状态</dt><dd>{node.personal.state}</dd></div>
        <div><dt>练习轨迹</dt><dd>{node.personal.practiceTrailCount} 次</dd></div>
        <div><dt>复习</dt><dd>{node.personal.nextReviewAt ? "已安排" : "无"}</dd></div>
      </dl>
      <div className="graph-v3-sidepanel-actions">
        <Link href={detailHref} className="objective-secondary-action">查看目标档案</Link>
        <ObjectivePrimaryAction action={node.personal.primaryAction} onExecute={props.onAction} />
      </div>
    </div>
  );
}
