import type {
  CompanionMemoryItemV1,
  CompanionMemoryStarMapV2,
  CompanionMemoryEntityTargetV2,
} from "@ailearn/shared/companion-memory-desktop-contracts";
import type { DesktopRouteV1 } from "@ailearn/shared/desktop-ipc-contracts";
import {
  createUniverseLayout,
  normalizeUnderstandingGraph,
  type GraphEdge,
  type GraphNode,
  type UnderstandingGraph,
  type UniverseLayout,
} from "./understanding-universe-data";

export type CompanionUniverseNodeRole = "memory" | "entity";

export interface CompanionMemoryUniverse {
  readonly graph: UnderstandingGraph;
  readonly layout: UniverseLayout;
  readonly memoryNodeIds: ReadonlyMap<string, string>;
  readonly memoryIdsByNode: ReadonlyMap<string, string>;
  readonly targetsByNode: ReadonlyMap<string, CompanionMemoryEntityTargetV2 | null>;
}

function memoryNodeId(memoryId: string) {
  return `memory:${memoryId}`;
}

function entityNodeId(entityType: string, entityId: string) {
  return `entity:${entityType}:${entityId}`;
}

function entityGraphType(entityType: string): GraphNode["type"] {
  if (entityType === "source") return "source";
  if (entityType === "note") return "note";
  if (entityType === "key_point") return "key_point";
  return "key_point";
}

export function buildCompanionMemoryUniverse(
  starMap: CompanionMemoryStarMapV2 | null,
  memoryItems: readonly CompanionMemoryItemV1[],
): CompanionMemoryUniverse {
  const memoryNodeIds = new Map<string, string>();
  const memoryIdsByNode = new Map<string, string>();
  const targetsByNode = new Map<string, CompanionMemoryEntityTargetV2 | null>();
  const itemsById = new Map(memoryItems.map((item) => [item.memoryItemId, item]));
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const entityNodes = new Map<string, GraphNode>();

  for (const mapNode of starMap?.nodes ?? []) {
    const id = memoryNodeId(mapNode.memoryId);
    memoryNodeIds.set(mapNode.memoryId, id);
    memoryIdsByNode.set(id, mapNode.memoryId);
    nodes.push({
      id,
      entityId: mapNode.memoryId,
      type: "card",
      label: mapNode.content,
      description: null,
      state: mapNode.state,
      parentId: null,
      evidenceCoverage: null,
      metadata: {
        visualRole: "memory" satisfies CompanionUniverseNodeRole,
        memoryKind: mapNode.kind,
        importance: mapNode.importance,
        updatedAt: mapNode.updatedAt,
      },
    });
    for (const link of mapNode.entityLinks) {
      const targetId = entityNodeId(link.entityType, link.entityId);
      if (!entityNodes.has(targetId)) {
        entityNodes.set(targetId, {
          id: targetId,
          entityId: link.entityId,
          type: entityGraphType(link.entityType),
          label: link.label,
          description: link.orphaned ? "关联实体已失效，无法导航" : null,
          state: link.orphaned ? "orphaned" : "linked",
          parentId: id,
          evidenceCoverage: null,
          metadata: {
            visualRole: "entity" satisfies CompanionUniverseNodeRole,
            entityType: link.entityType,
            orphaned: link.orphaned,
          },
        });
        targetsByNode.set(targetId, link.target);
      }
      edges.push({
        id: `memory-link:${mapNode.memoryId}:${link.entityType}:${link.entityId}`,
        from: targetId,
        to: id,
        type: "derived_from",
        metadata: { orphaned: link.orphaned },
      });
    }
  }

  // 星图端点是唯一节点权威：候选与归档只留在左侧列表，不能绕过服务端
  // star-map 的隐私过滤进入图中。列表只用于覆盖同一已确认节点的最新显示状态。
  for (const node of nodes) {
    const memoryId = memoryIdsByNode.get(node.id);
    const item = memoryId ? itemsById.get(memoryId) : null;
    if (!item) continue;
    node.state = item.pinned ? "pinned" : "active";
    node.metadata.importance = item.importance;
    node.metadata.updatedAt = item.updatedAt;
  }

  const graph = normalizeUnderstandingGraph({ nodes: [...nodes, ...entityNodes.values()], edges });
  return {
    graph,
    layout: createUniverseLayout(graph),
    memoryNodeIds,
    memoryIdsByNode,
    targetsByNode,
  };
}

export function routeForMemoryEntityTarget(target: CompanionMemoryEntityTargetV2): DesktopRouteV1 {
  switch (target.kind) {
    case "note":
      return { kind: "note.detail", noteId: target.noteId };
    case "source":
      return { kind: "source.detail", sourceId: target.sourceId };
    case "objective":
    case "understanding":
      return { kind: "objective.detail", objectiveId: target.objectiveId };
    case "learning_run":
      return { kind: "learningRun.detail", runId: target.runId };
  }
}
