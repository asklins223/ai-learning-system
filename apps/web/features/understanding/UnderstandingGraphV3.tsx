/**
 * Plan 23 TP-11..TP-17：Understanding Graph V3（objective-native）。
 *
 * - 数据：只消费 /v3/understanding/topology（UnderstandingTopologySnapshotV3）；
 *   节点只允许 source/note/objective/evidence（guard 断言，无 card/key_point）；
 * - 视觉（2026-08-22 重构）：节点为 HTML「纸面卡片」层（与笔记/来源列表同一套
 *   --color-* token 与卡片语言），SVG 只负责血缘连线；标题两行截断，
 *   不再 slice 硬切；类型/状态一律走中文标签映射；
 * - 侧栏：选中 Objective 显示来源、个人状态与 typed action（TP-14/15）；
 * - loading/empty/degraded：0 Objective 仍展示 Note；缺 origin 有修复提示（TP-17）。
 */
"use client";

import { useCallback, useEffect, useMemo, useState, type JSX } from "react";
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
import { nodeKindLabel, personalStateLabel } from "@/features/learning-objective/labels";

/* ── 布局常量：四条固定泳道，节点为等高纸面卡片 ── */

const KIND_ORDER = ["source", "note", "objective", "evidence"] as const;
type NodeKind = (typeof KIND_ORDER)[number];

const LANE_W = 248;
const LANE_GAP = 72;
const NODE_H = 96;
const NODE_GAP = 16;
const HEADER_H = 40;
const PAD_Y = 14;
const CANVAS_W = KIND_ORDER.length * LANE_W + (KIND_ORDER.length - 1) * LANE_GAP;

const colLeft = (col: number): number => col * (LANE_W + LANE_GAP);

function nodeKindOf(node: UnderstandingNodeProjectionV3): NodeKind {
  return node.nodeRef.kind;
}

function nodeLabel(node: UnderstandingNodeProjectionV3): string {
  if (node.nodeRef.kind === "evidence") {
    return (node as Extract<UnderstandingNodeProjectionV3, { nodeRef: { kind: "evidence" } }>).supportSummary;
  }
  return (node as { label: string }).label;
}

/** 节点第三行元信息（中文；未知枚举 fail-visible）。 */
function nodeMeta(node: UnderstandingNodeProjectionV3): string | null {
  switch (node.nodeRef.kind) {
    case "source": {
      const modality = (node as { modality: string }).modality;
      return MODALITY_LABELS[modality] ?? modality;
    }
    case "note": {
      const freshness = (node as { freshness: string }).freshness;
      return NOTE_FRESHNESS_LABELS[freshness] ?? freshness;
    }
    case "objective":
      return personalStateLabel((node as ObjectiveNodeProjectionV3).personal.state);
    case "evidence":
      return (node as { restricted: boolean }).restricted ? "受限引用" : null;
    default:
      return null;
  }
}

const MODALITY_LABELS: Record<string, string> = {
  web: "网页",
  pdf: "PDF",
  text: "文本",
  video: "视频",
  audio: "音频",
};

const NOTE_FRESHNESS_LABELS: Record<string, string> = {
  current: "最新",
  source_outdated: "来源已更新",
  archived: "已归档",
};

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
  kind: NodeKind;
  col: number;
  x: number;
  y: number;
  node: UnderstandingNodeProjectionV3;
}

interface EdgePath {
  edge: UnderstandingEdgeProjectionV3;
  d: string;
}

/** 前向边走水平贝塞尔；同列/回边沿泳道右侧绕行，避免穿过卡片。 */
function edgePathD(from: LayoutNode, to: LayoutNode): string {
  const y1 = from.y + NODE_H / 2;
  const y2 = to.y + NODE_H / 2;
  if (to.col > from.col) {
    const x1 = from.x + LANE_W;
    const x2 = to.x;
    const mx = (x1 + x2) / 2;
    return `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
  }
  const x1 = from.x + LANE_W;
  const x2 = to.x + LANE_W;
  const ax = Math.max(x1, x2) + 38;
  return `M ${x1} ${y1} C ${ax} ${y1}, ${ax} ${y2}, ${x2} ${y2}`;
}

export function UnderstandingGraphV3(): JSX.Element {
  const router = useRouter();
  const [snapshot, setSnapshot] = useState<UnderstandingTopologySnapshotV3 | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);

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
    // 窄屏默认缩小一档，首屏能看到两条泳道（仅客户端，不影响 SSR 一致性）。
    if (typeof window !== "undefined" && window.innerWidth < 720) setZoom(0.62);
  }, [load]);

  // 分层布局：source/note 左列、objective 中列、evidence 右列
  const layout = useMemo<LayoutNode[]>(() => {
    if (!snapshot) return [];
    const columns: Record<NodeKind, LayoutNode[]> = { source: [], note: [], objective: [], evidence: [] };
    for (const node of snapshot.nodes) {
      const kind = nodeKindOf(node);
      columns[kind].push({
        key: kind + ":" + nodeRefId(node),
        kind,
        col: KIND_ORDER.indexOf(kind),
        x: 0,
        y: 0,
        node,
      });
    }
    const result: LayoutNode[] = [];
    KIND_ORDER.forEach((kind, col) => {
      const list = columns[kind];
      list.forEach((item, index) => {
        item.x = colLeft(col);
        item.y = HEADER_H + PAD_Y + index * (NODE_H + NODE_GAP);
      });
      result.push(...list);
    });
    return result;
  }, [snapshot]);

  const layoutByKey = useMemo(() => new Map(layout.map((l) => [l.key, l])), [layout]);
  const selected = selectedKey ? layoutByKey.get(selectedKey) ?? null : null;

  const laneCount = useMemo(() => {
    const counts: Record<NodeKind, number> = { source: 0, note: 0, objective: 0, evidence: 0 };
    for (const item of layout) counts[item.kind] += 1;
    return counts;
  }, [layout]);

  const maxColumn = useMemo(
    () => Math.max(1, ...KIND_ORDER.map((kind) => laneCount[kind])),
    [laneCount],
  );
  const canvasH = Math.max(
    340,
    HEADER_H + PAD_Y * 2 + maxColumn * (NODE_H + NODE_GAP) - NODE_GAP,
  );

  const edges = useMemo<EdgePath[]>(() => {
    if (!snapshot) return [];
    const paths: EdgePath[] = [];
    for (const edge of snapshot.edges) {
      const from = layoutByKey.get(edge.from.kind + ":" + edge.from.id);
      const to = layoutByKey.get(edge.to.kind + ":" + edge.to.id);
      if (!from || !to) continue;
      paths.push({ edge, d: edgePathD(from, to) });
    }
    return paths;
  }, [snapshot, layoutByKey]);

  /** 选中节点的邻接边：用于高亮连线、弱化无关内容。 */
  const linkedEdgeIds = useMemo(() => {
    if (!snapshot || !selectedKey) return null;
    const ids = new Set<string>();
    for (const edge of snapshot.edges) {
      const fromKey = edge.from.kind + ":" + edge.from.id;
      const toKey = edge.to.kind + ":" + edge.to.id;
      if (fromKey === selectedKey || toKey === selectedKey) ids.add(edge.edgeId);
    }
    return ids;
  }, [snapshot, selectedKey]);

  const onWheel = useCallback((event: React.WheelEvent) => {
    const next = Math.min(2, Math.max(0.5, zoom * (event.deltaY < 0 ? 1.08 : 0.93)));
    setZoom(next);
  }, [zoom]);

  if (error && !snapshot) {
    return <ObjectiveError message={error} retryable onRetry={() => void load()} />;
  }
  if (!snapshot) {
    return <ObjectiveSkeleton rows={6} />;
  }

  const objectiveNodes = layout.filter((l) => l.kind === "objective");
  const noteCount = laneCount.note;

  return (
    <div className={"graph-v3" + (selectedKey ? " has-selection" : "")}>
      <div className="graph-v3-toolbar">
        <div className="graph-v3-legend" aria-label="图例">
          {KIND_ORDER.map((kind) => (
            <span key={kind} className="graph-v3-legend-item" data-kind={kind}>
              <i aria-hidden="true" />
              {nodeKindLabel(kind)}
              <b>{laneCount[kind]}</b>
            </span>
          ))}
        </div>
        <div className="graph-v3-zoom">
          <button type="button" onClick={() => setZoom(Math.min(2, zoom * 1.2))} aria-label="放大">＋</button>
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
          <span className="graph-v3-empty-eyebrow"><i aria-hidden="true" />理解星图</span>
          <h3>还没有可展示的知识内容</h3>
          <p>先收一份材料，星图会随着阅读、笔记与目标逐步长出来。</p>
          <Link href="/sources" className="objective-primary-action">先去收一份材料</Link>
        </div>
      ) : objectiveNodes.length === 0 ? (
        <div className="graph-v3-empty">
          <span className="graph-v3-empty-eyebrow"><i aria-hidden="true" />理解星图</span>
          <h3>已有笔记，但还没有学习目标</h3>
          <p>从笔记生成学习目标后，这里会展示知识与证据的血缘。</p>
          <Link href="/notes" className="objective-primary-action">从笔记生成</Link>
        </div>
      ) : (
        <div className="graph-v3-stage">
          <div className="graph-v3-viewport" onWheel={onWheel}>
            <div className="graph-v3-canvas" style={{ width: CANVAS_W * zoom, height: canvasH * zoom }}>
              <div
                className="graph-v3-world"
                style={{ width: CANVAS_W, height: canvasH, transform: `scale(${zoom})` }}
              >
                {/* 连线层：纯装饰，语义由节点卡片承载 */}
                <svg
                  className="graph-v3-svg"
                  width={CANVAS_W}
                  height={canvasH}
                  viewBox={`0 0 ${CANVAS_W} ${canvasH}`}
                  aria-hidden="true"
                  focusable="false"
                >
                  {edges.map(({ edge, d }) => {
                    const linked = linkedEdgeIds?.has(edge.edgeId) ?? false;
                    return (
                      <path
                        key={edge.edgeId}
                        d={d}
                        className={
                          "graph-v3-edge graph-v3-edge--" + edge.kind +
                          (linked ? " is-linked" : "")
                        }
                      />
                    );
                  })}
                </svg>

                {KIND_ORDER.map((kind, col) => (
                  <div
                    key={kind}
                    className="graph-v3-lane-header"
                    data-kind={kind}
                    style={{ left: colLeft(col), top: 0, width: LANE_W, height: HEADER_H }}
                  >
                    <i aria-hidden="true" />
                    <span>{nodeKindLabel(kind)}</span>
                    <b>{laneCount[kind]}</b>
                  </div>
                ))}

                {layout.map((item) => {
                  const isSelected = selectedKey === item.key;
                  return (
                    <button
                      key={item.key}
                      type="button"
                      className={
                        "graph-v3-node graph-v3-node--" + item.kind +
                        (isSelected ? " is-selected" : "")
                      }
                      style={{ left: item.x, top: item.y, width: LANE_W, height: NODE_H }}
                      onClick={() => setSelectedKey(isSelected ? null : item.key)}
                      aria-pressed={isSelected}
                    >
                      <span className="graph-v3-node-kind">
                        <i aria-hidden="true" />
                        {nodeKindLabel(item.kind)}
                      </span>
                      <strong className="graph-v3-node-title">{nodeLabel(item.node)}</strong>
                      {nodeMeta(item.node) && (
                        <span className="graph-v3-node-meta">{nodeMeta(item.node)}</span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

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
  const detailHref = "/learning-cards/" + (node.activeCardId ?? node.nodeRef.objectiveId);
  const reviewDue = node.personal.nextReviewAt
    ? "已安排 · " + new Date(node.personal.nextReviewAt).toLocaleDateString("zh-CN", { month: "long", day: "numeric" })
    : "无";
  return (
    <div className="graph-v3-sidepanel-body">
      <header>
        <h3>{node.label}</h3>
        <button type="button" onClick={props.onClose} aria-label="关闭详情">×</button>
      </header>
      <ObjectiveStatusChip state={chipStateOf(node)} />
      <p className="graph-v3-sidepanel-summary">{node.publicSummary}</p>
      <dl className="graph-v3-sidepanel-state">
        <div><dt>状态</dt><dd>{personalStateLabel(node.personal.state)}</dd></div>
        <div><dt>练习轨迹</dt><dd>{node.personal.practiceTrailCount} 次</dd></div>
        <div><dt>复习</dt><dd>{reviewDue}</dd></div>
      </dl>
      <div className="graph-v3-sidepanel-actions">
        <Link href={detailHref} className="objective-secondary-action">查看目标档案</Link>
        <ObjectivePrimaryAction action={node.personal.primaryAction} onExecute={props.onAction} />
      </div>
    </div>
  );
}
