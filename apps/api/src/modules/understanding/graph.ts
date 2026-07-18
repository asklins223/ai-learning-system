export type UnderstandingGraphNodeType = "source" | "note" | "card" | "key_point";

export type UnderstandingGraphEdgeType = "derived_from" | "generated_from" | "contains";

export interface UnderstandingGraphNode {
  id: string;
  entityId: string;
  type: UnderstandingGraphNodeType;
  label: string;
  description: string | null;
  state: string | null;
  href: string;
  parentId: string | null;
  evidenceCoverage: number | null;
  hardEvidenceCount: number;
  softEvidenceCount: number;
  misunderstandingCount: number;
  lastValidatedAt: string | null;
  nextReviewAt: string | null;
  metadata: Record<string, unknown>;
}

export interface UnderstandingGraphEdge {
  id: string;
  from: string;
  to: string;
  type: UnderstandingGraphEdgeType;
  strength: number;
}

export interface UnderstandingGraphMeta {
  generatedAt: string;
  totalCards: number;
  nodeCount: number;
  edgeCount: number;
  sourceCount: number;
  noteCount: number;
  cardCount: number;
  keyPointCount: number;
  truncated: boolean;
  stateCounts: Record<string, number>;
}

export interface UnderstandingGraph {
  nodes: UnderstandingGraphNode[];
  edges: UnderstandingGraphEdge[];
  meta: UnderstandingGraphMeta;
}

export interface GraphSourceRecord {
  id: string;
  type: string;
  title: string;
  origin: string | null;
  status: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface GraphNoteRecord {
  id: string;
  title: string;
  sourceId: string | null;
  currentVersionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GraphNoteVersionRecord {
  id: string;
  noteId: string;
  versionNo: number;
  createdAt: string;
}

export interface GraphCardRecord {
  id: string;
  noteVersionId: string;
  title: string;
  summary: string;
  status: string;
  state: string;
  evidenceCoverage: number;
  hardEvidenceCount: number;
  softEvidenceCount: number;
  misunderstandingCount: number;
  lastValidatedAt: string | null;
  nextReviewAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GraphKeyPointRecord {
  id: string;
  cardId: string;
  ordinal: number;
  claim: string;
  quoteText: string;
  segmentRef: { blockId?: string; blockOrdinal?: number } | null;
  hardEvidenceCount: number;
  softEvidenceCount: number;
  misunderstandingCount: number;
  lastValidatedAt: string | null;
}

export interface BuildUnderstandingGraphInput {
  generatedAt: string;
  totalCards: number;
  sources: GraphSourceRecord[];
  notes: GraphNoteRecord[];
  noteVersions: GraphNoteVersionRecord[];
  cards: GraphCardRecord[];
  keyPoints: GraphKeyPointRecord[];
}

export const UNDERSTANDING_GRAPH_CARD_LIMIT = 200;

const nodeId = (type: UnderstandingGraphNodeType, entityId: string) => `${type}:${entityId}`;

const edgeId = (type: UnderstandingGraphEdgeType, from: string, to: string) =>
  `${type}:${from}->${to}`;

/**
 * 把已按 workspace/user 隔离的数据库投影组装为星图 DTO。
 *
 * 这是纯函数：它不访问数据库、不读取当前时间，也不会推断语义关系。
 * 三种边都必须由调用方提供记录中的真实外键支持：
 * source <- notes.sourceId、note <- noteVersions.noteId <- cards.noteVersionId、
 * card <- cardKeyPoints.cardId。
 */
export function buildUnderstandingGraphDto(input: BuildUnderstandingGraphInput): UnderstandingGraph {
  const sourceById = new Map(input.sources.map((source) => [source.id, source]));
  const noteById = new Map(input.notes.map((note) => [note.id, note]));
  const versionById = new Map(input.noteVersions.map((version) => [version.id, version]));
  const uniqueCards = new Map<string, GraphCardRecord>();
  for (const card of input.cards) {
    if (!uniqueCards.has(card.id)) uniqueCards.set(card.id, card);
  }
  const keyPointsByCard = new Map<string, GraphKeyPointRecord[]>();

  for (const keyPoint of input.keyPoints) {
    const group = keyPointsByCard.get(keyPoint.cardId) ?? [];
    group.push(keyPoint);
    keyPointsByCard.set(keyPoint.cardId, group);
  }
  for (const group of keyPointsByCard.values()) {
    group.sort((a, b) => a.ordinal - b.ordinal || a.id.localeCompare(b.id));
  }

  const nodes = new Map<string, UnderstandingGraphNode>();
  const edges = new Map<string, UnderstandingGraphEdge>();
  const stateCounts: Record<string, number> = {};

  const addNode = (node: UnderstandingGraphNode) => {
    if (!nodes.has(node.id)) nodes.set(node.id, node);
  };
  const addEdge = (edge: Omit<UnderstandingGraphEdge, "id">) => {
    const id = edgeId(edge.type, edge.from, edge.to);
    if (!edges.has(id)) edges.set(id, { id, ...edge });
  };

  for (const card of uniqueCards.values()) {
    const version = versionById.get(card.noteVersionId);
    const note = version ? noteById.get(version.noteId) : undefined;
    const source = note?.sourceId ? sourceById.get(note.sourceId) : undefined;

    if (source) {
      const sourceNodeId = nodeId("source", source.id);
      addNode({
        id: sourceNodeId,
        entityId: source.id,
        type: "source",
        label: source.title,
        description: source.origin ?? null,
        state: null,
        href: `/sources/${source.id}`,
        parentId: null,
        evidenceCoverage: null,
        hardEvidenceCount: 0,
        softEvidenceCount: 0,
        misunderstandingCount: 0,
        lastValidatedAt: null,
        nextReviewAt: null,
        metadata: {
          sourceType: source.type,
          status: source.status,
          origin: source.origin,
          createdAt: source.createdAt,
          updatedAt: source.updatedAt,
          sourceMetadata: source.metadata ?? {},
        },
      });
    }

    if (note) {
      const noteNodeId = nodeId("note", note.id);
      const sourceNodeId = source ? nodeId("source", source.id) : null;
      addNode({
        id: noteNodeId,
        entityId: note.id,
        type: "note",
        label: note.title,
        description: "笔记",
        state: null,
        href: `/notes/${note.id}`,
        parentId: sourceNodeId,
        evidenceCoverage: null,
        hardEvidenceCount: 0,
        softEvidenceCount: 0,
        misunderstandingCount: 0,
        lastValidatedAt: null,
        nextReviewAt: null,
        metadata: {
          sourceId: note.sourceId,
          currentVersionId: note.currentVersionId,
          createdAt: note.createdAt,
          updatedAt: note.updatedAt,
        },
      });
      if (sourceNodeId) {
        addEdge({
          from: sourceNodeId,
          to: noteNodeId,
          type: "derived_from",
          strength: 1,
        });
      }
    }

    const cardNodeId = nodeId("card", card.id);
    const noteNodeId = note ? nodeId("note", note.id) : null;
    addNode({
      id: cardNodeId,
      entityId: card.id,
      type: "card",
      label: card.title,
      description: card.summary || null,
      state: card.state,
      href: `/cards/${card.id}`,
      parentId: noteNodeId,
      evidenceCoverage: card.evidenceCoverage,
      hardEvidenceCount: card.hardEvidenceCount,
      softEvidenceCount: card.softEvidenceCount,
      misunderstandingCount: card.misunderstandingCount,
      lastValidatedAt: card.lastValidatedAt,
      nextReviewAt: card.nextReviewAt,
      metadata: {
        status: card.status,
        noteVersionId: card.noteVersionId,
        noteId: version?.noteId ?? null,
        noteVersionNo: version?.versionNo ?? null,
        isCurrentNoteVersion: note?.currentVersionId === version?.id,
        createdAt: card.createdAt,
        updatedAt: card.updatedAt,
      },
    });
    if (noteNodeId) {
      addEdge({
        from: noteNodeId,
        to: cardNodeId,
        type: "generated_from",
        strength: 1,
      });
    }
    stateCounts[card.state] = (stateCounts[card.state] ?? 0) + 1;

    for (const keyPoint of keyPointsByCard.get(card.id) ?? []) {
      const keyPointNodeId = nodeId("key_point", keyPoint.id);
      addNode({
        id: keyPointNodeId,
        entityId: keyPoint.id,
        type: "key_point",
        label: keyPoint.claim,
        description: keyPoint.quoteText || null,
        // keyPoint 没有独立的理解状态表，不能冒充 card 状态。
        state: null,
        href: `/cards/${card.id}`,
        parentId: cardNodeId,
        evidenceCoverage: keyPoint.hardEvidenceCount > 0 ? 1 : 0,
        hardEvidenceCount: keyPoint.hardEvidenceCount,
        softEvidenceCount: keyPoint.softEvidenceCount,
        misunderstandingCount: keyPoint.misunderstandingCount,
        lastValidatedAt: keyPoint.lastValidatedAt,
        nextReviewAt: null,
        metadata: {
          cardId: keyPoint.cardId,
          ordinal: keyPoint.ordinal,
          segmentRef: keyPoint.segmentRef,
        },
      });
      addEdge({
        from: cardNodeId,
        to: keyPointNodeId,
        type: "contains",
        strength: 1,
      });
    }
  }

  const nodeList = Array.from(nodes.values());
  const edgeList = Array.from(edges.values());
  const sourceCount = nodeList.filter((node) => node.type === "source").length;
  const noteCount = nodeList.filter((node) => node.type === "note").length;
  const cardCount = nodeList.filter((node) => node.type === "card").length;
  const keyPointCount = nodeList.filter((node) => node.type === "key_point").length;

  return {
    nodes: nodeList,
    edges: edgeList,
    meta: {
      generatedAt: input.generatedAt,
      totalCards: input.totalCards,
      nodeCount: nodeList.length,
      edgeCount: edgeList.length,
      sourceCount,
      noteCount,
      cardCount,
      keyPointCount,
      truncated: input.totalCards > UNDERSTANDING_GRAPH_CARD_LIMIT,
      stateCounts,
    },
  };
}
