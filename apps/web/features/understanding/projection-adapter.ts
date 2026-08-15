/**
 * UnderstandingProjectionV2 → 旧 UnderstandingGraph 形状适配（文档 16 §15.2）。
 *
 * graph 页主渲染切流（star_map_action_v1）后，Canvas/布局/筛选管线继续消费
 * 旧 UnderstandingGraph 形状；本模块把投影的 shared+personal 平面映射过去。
 *
 * 诚实降级：投影不含 evidence 计数/误解数/验证时间（旧 reader 的字段），
 * 映射为 0/null；状态只来自 §15.2 personal.state（unknown/forming/stable/
 * fragile/needs_repair）。证据统计字段的补全属 P7 服务端剩余。
 */

import type { UnderstandingGraph, GraphNode, GraphEdge } from "@/lib/understanding-graph";

type ProjectionNodeRef =
  | { kind: "source"; sourceId: string }
  | { kind: "note"; noteId: string }
  | { kind: "card"; cardId: string }
  | { kind: "key_point"; keyPointId: string }
  | { kind: "evidence"; evidenceId: string };

interface ProjectionNode {
  nodeRef: ProjectionNodeRef;
  label: string;
  shared: { archived: boolean; sourceFingerprint: string };
  personal: {
    state: "unknown" | "forming" | "stable" | "fragile" | "needs_repair";
    nextReviewAt: string | null;
    activeScheduleId: string | null;
    lastCanonicalEventId: string | null;
    practiceTrailCount: number;
  } | null;
}

interface ProjectionEdge {
  edgeId: string;
  from: ProjectionNodeRef;
  to: ProjectionNodeRef;
  kind: "derived_from" | "supports" | "contains" | "prerequisite" | "next";
  provenanceHash: string;
}

export interface UnderstandingProjectionResponseV2 {
  version: 2;
  nodes: ProjectionNode[];
  edges: ProjectionEdge[];
}

function refKey(ref: ProjectionNodeRef): string {
  switch (ref.kind) {
    case "source": return `source:${ref.sourceId}`;
    case "note": return `note:${ref.noteId}`;
    case "card": return `card:${ref.cardId}`;
    case "key_point": return `key_point:${ref.keyPointId}`;
    case "evidence": return `evidence:${ref.evidenceId}`;
  }
}

function refEntityId(ref: ProjectionNodeRef): string {
  switch (ref.kind) {
    case "source": return ref.sourceId;
    case "note": return ref.noteId;
    case "card": return ref.cardId;
    case "key_point": return ref.keyPointId;
    case "evidence": return ref.evidenceId;
  }
}

/** §15.2 personal.state → 旧 GraphNode.state 枚举（FILTERS 的 six-value 语义）。 */
function mapState(state: ProjectionNode["personal"]): string | null {
  if (!state) return null;
  switch (state.state) {
    case "needs_repair": return "misunderstood";
    case "fragile": return "due_review";
    case "stable":
    case "forming": return "preliminary_understood";
    case "unknown": return "unseen";
    default: return null;
  }
}

/** 投影边 kind → 旧 GraphEdgeType（note→card 的 derived_from 还原为 generated_from）。 */
function mapEdgeType(
  kind: ProjectionEdge["kind"],
  from: ProjectionNodeRef,
  to: ProjectionNodeRef,
): GraphEdge["type"] | null {
  switch (kind) {
    case "contains":
      return "contains";
    case "supports":
      // evidence → key_point（§15.2 边 kind）。
      return "supports";
    case "prerequisite":
      // 前置 → 目标（§15.2/迁移 0145）。
      return "prerequisite";
    case "derived_from":
      // source→note 保持 derived_from；note→card 旧图语义为 generated_from。
      if (from.kind === "note" && to.kind === "card") return "generated_from";
      return "derived_from";
    default:
      // prerequisite/next：旧 Canvas 无对应类型，跳过（V1 服务端不产出）。
      return null;
  }
}

/**
 * 投影响应 → UnderstandingGraph。输入非法/形状不符返回 null（调用方 fail closed）。
 */
export function projectionToUnderstandingGraph(raw: unknown): UnderstandingGraph | null {
  if (!raw || typeof raw !== "object") return null;
  const projection = raw as UnderstandingProjectionResponseV2;
  if (!Array.isArray(projection.nodes) || !Array.isArray(projection.edges)) return null;

  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  // key_point → card 映射（href/parent 需要）。
  const cardByKp = new Map<string, string>();
  const parentOf = new Map<string, string>();
  for (const edge of projection.edges) {
    const fromKey = refKey(edge.from);
    const toKey = refKey(edge.to);
    if (edge.kind === "contains" && edge.from.kind === "card" && edge.to.kind === "key_point") {
      cardByKp.set(edge.to.keyPointId, edge.from.cardId);
      parentOf.set(toKey, fromKey);
    }
    if (edge.kind === "derived_from") {
      parentOf.set(toKey, fromKey);
    }
  }

  for (const node of projection.nodes) {
    const ref = node.nodeRef;
    if (!ref || typeof ref.kind !== "string") continue;
    const key = refKey(ref);
    const entityId = refEntityId(ref);
    const type = ref.kind;
    const href = type === "source"
      ? `/sources/${entityId}`
      : type === "note"
        ? `/notes/${entityId}`
        : type === "card"
          ? `/cards/${entityId}`
          : type === "key_point" && cardByKp.get(entityId)
            ? `/cards/${cardByKp.get(entityId)}`
            : null;
    const state = type === "key_point" || type === "card" ? mapState(node.personal) : null;
    nodes.set(key, {
      id: key,
      entityId,
      type: type as GraphNode["type"],
      label: node.label || (type === "card" ? "（未命名学习卡）" : type === "key_point" ? "要点" : type === "evidence" ? "证据引用" : type),
      description: null,
      state,
      href,
      parentId: parentOf.get(key) ?? null,
      evidenceCoverage: null,
      hardEvidenceCount: 0,
      softEvidenceCount: 0,
      misunderstandingCount: 0,
      lastValidatedAt: null,
      nextReviewAt: node.personal?.nextReviewAt ?? null,
      metadata: {
        projection: true,
        personalState: node.personal?.state ?? null,
        activeScheduleId: node.personal?.activeScheduleId ?? null,
        practiceTrailCount: node.personal?.practiceTrailCount ?? 0,
        lastCanonicalEventId: node.personal?.lastCanonicalEventId ?? null,
        archived: node.shared?.archived ?? false,
        sourceFingerprint: node.shared?.sourceFingerprint ?? "",
      },
    });
  }

  for (const edge of projection.edges) {
    const fromKey = refKey(edge.from);
    const toKey = refKey(edge.to);
    if (!nodes.has(fromKey) || !nodes.has(toKey)) continue;
    const type = mapEdgeType(edge.kind, edge.from, edge.to);
    if (!type) continue;
    const id = `${type}:${fromKey}:${toKey}`;
    edges.set(id, { id, from: fromKey, to: toKey, type, strength: 1 });
  }

  return {
    nodes: Array.from(nodes.values()),
    edges: Array.from(edges.values()),
  };
}
