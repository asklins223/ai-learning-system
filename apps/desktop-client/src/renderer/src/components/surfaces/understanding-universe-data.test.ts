import { describe, expect, it } from "vitest";
import {
  createUniverseLayout,
  filterUnderstandingGraph,
  getSelectedGraphPath,
  isWholeLabel,
  labelLeader,
  labelSafeBox,
  normalizeUnderstandingGraph,
  STAR_MAP_NODE_RADIUS,
  type GraphEdge,
  type GraphNode,
  type UnderstandingGraph,
} from "./understanding-universe-data";

let seq = 0;
function nextId(prefix = "n"): string {
  seq += 1;
  return `${prefix}-${String(seq).padStart(4, "0")}`;
}

function node(
  type: GraphNode["type"],
  overrides: Partial<GraphNode> = {},
): GraphNode {
  return {
    id: overrides.id ?? nextId(type),
    entityId: overrides.entityId ?? nextId("e"),
    type,
    label: overrides.label ?? `${type} label`,
    description: overrides.description ?? null,
    state: overrides.state ?? null,
    parentId: null,
    evidenceCoverage: null,
    metadata: {},
    ...overrides,
  };
}

function edge(from: string, to: string, type: GraphEdge["type"] = "derived_from"): GraphEdge {
  return { id: nextId("edge"), from, to, type };
}

function chainGraph(): UnderstandingGraph {
  const source = node("source");
  const note = node("note");
  const card = node("card", { state: "misunderstood" });
  const claim = node("key_point");
  return {
    nodes: [source, note, card, claim],
    edges: [edge(source.id, note.id, "generated_from"), edge(note.id, card.id, "derived_from"), edge(card.id, claim.id, "contains")],
  };
}

describe("normalizeUnderstandingGraph", () => {
  it("drops edges that reference missing nodes", () => {
    const graph = chainGraph();
    const dirty: UnderstandingGraph = {
      nodes: graph.nodes.slice(0, 2),
      edges: [...graph.edges, edge("ghost-a", "ghost-b")],
    };
    const clean = normalizeUnderstandingGraph(dirty);
    expect(clean.edges).toHaveLength(1);
    expect(clean.nodes).toHaveLength(2);
  });

  it("keeps the first of semantically duplicate edges regardless of order", () => {
    const a = node("source");
    const b = node("note");
    const first = edge(a.id, b.id, "generated_from");
    const duplicate = { ...edge(a.id, b.id, "generated_from"), id: "edge-dup" };
    const clean = normalizeUnderstandingGraph({ nodes: [a, b], edges: [duplicate, first] });
    expect(clean.edges).toHaveLength(1);
    expect(clean.edges[0].id).toBe(first.id);
  });
});

describe("filterUnderstandingGraph", () => {
  it("keeps the full lineage of a search match", () => {
    const graph = chainGraph();
    const note = graph.nodes[1];
    const filtered = filterUnderstandingGraph(graph, { query: note.label });
    const ids = new Set(filtered.nodes.map((item) => item.id));
    // The note, its source ancestor and its card + claim descendants all stay.
    expect(ids.has(graph.nodes[0].id)).toBe(true);
    expect(ids.has(note.id)).toBe(true);
    expect(ids.has(graph.nodes[2].id)).toBe(true);
    expect(ids.has(graph.nodes[3].id)).toBe(true);
  });

  it("hides sources when showSources is false without breaking the chain", () => {
    const graph = chainGraph();
    const filtered = filterUnderstandingGraph(graph, { showSources: false });
    const types = new Set(filtered.nodes.map((item) => item.type));
    expect(types.has("source")).toBe(false);
    expect(filtered.nodes.length).toBe(graph.nodes.length - 1);
  });

  it("filters card states and preserves lineage", () => {
    const graph = chainGraph();
    const filtered = filterUnderstandingGraph(graph, { state: "misunderstood" });
    expect(filtered.nodes.map((item) => item.id).sort()).toEqual(graph.nodes.map((item) => item.id).sort());
  });
});

describe("getSelectedGraphPath", () => {
  it("returns ancestors and descendants of the selection", () => {
    const graph = chainGraph();
    const card = graph.nodes[2];
    const path = getSelectedGraphPath(graph, card.id);
    expect(path.selectedIds).toEqual([card.id]);
    expect(path.ancestorIds).toEqual(expect.arrayContaining([graph.nodes[0].id, graph.nodes[1].id]));
    expect(path.descendantIds).toEqual([graph.nodes[3].id]);
  });

  it("terminates on cyclic data", () => {
    const a = node("note");
    const b = node("note");
    const graph: UnderstandingGraph = { nodes: [a, b], edges: [edge(a.id, b.id), edge(b.id, a.id)] };
    const path = getSelectedGraphPath(graph, a.id);
    expect(path.nodeIds.sort()).toEqual([a.id, b.id].sort());
  });
});

describe("createUniverseLayout", () => {
  it("places a single node at the origin", () => {
    const only = node("card");
    const layout = createUniverseLayout({ nodes: [only], edges: [] });
    expect(layout.positions[only.id]).toEqual({ x: 0, y: 0 });
  });

  it("is deterministic for the same graph", () => {
    const graph = chainGraph();
    const first = createUniverseLayout(graph);
    const second = createUniverseLayout({ nodes: [...graph.nodes].reverse(), edges: [...graph.edges].reverse() });
    expect(first.positions).toEqual(second.positions);
  });

  it("keeps stars of a dense cluster from overlapping", () => {
    const nodes = Array.from({ length: 60 }, (_, index) => (
      node(index % 3 === 0 ? "card" : index % 3 === 1 ? "note" : "key_point", {
        id: `dense-${String(index).padStart(3, "0")}`,
        state: index % 3 === 0 ? "preliminary_understood" : null,
      })
    ));
    // One hub with 59 children forces the collision fallback paths.
    const hub = nodes[0];
    const edges = nodes.slice(1).map((child) => edge(hub.id, child.id, "derived_from"));
    const layout = createUniverseLayout({ nodes, edges });
    const placed = nodes
      .map((item) => ({ node: item, point: layout.positions[item.id] }))
      .filter((item): item is { node: GraphNode; point: { x: number; y: number } } => Boolean(item.point));
    expect(placed).toHaveLength(nodes.length);
    for (let i = 0; i < placed.length; i += 1) {
      for (let j = i + 1; j < placed.length; j += 1) {
        const left = placed[i];
        const right = placed[j];
        const minimum = STAR_MAP_NODE_RADIUS[left.node.type] + STAR_MAP_NODE_RADIUS[right.node.type] + 6;
        const distance = Math.hypot(left.point.x - right.point.x, left.point.y - right.point.y);
        expect(distance).toBeGreaterThanOrEqual(minimum - 2);
      }
    }
  });
});

describe("星图标签的几何（评审 P11 / B5）", () => {
  const chrome = { top: 150, bottom: 90, left: 400, right: 270 };

  it("安全矩形把浮层让出来的空间排除在外，并留 12px 内边距", () => {
    const box = labelSafeBox(1440, 900, chrome);
    expect(box).toEqual({ left: 412, top: 162, right: 1158, bottom: 798 });
  });

  it("浮层比画布还宽时不翻负——否则一条标签都画不出来", () => {
    const box = labelSafeBox(600, 400, { top: 300, bottom: 300, left: 500, right: 500 });
    expect(box.right).toBeGreaterThanOrEqual(box.left);
    expect(box.bottom).toBeGreaterThanOrEqual(box.top);
  });

  it("引线从节点边缘连到牌子靠它那一侧，不从圆心起、也不插进牌子", () => {
    const below = labelLeader({ x: 500, y: 300, radius: 14 }, { x: 500, y: 331, width: 120, height: 20 });
    expect(below).toEqual({ x1: 500, y1: 314, x2: 500, y2: 321 });

    const right = labelLeader({ x: 500, y: 300, radius: 14 }, { x: 531 + 60, y: 300, width: 120, height: 20 });
    expect(right).toEqual({ x1: 514, y1: 300, x2: 531, y2: 300 });

    const left = labelLeader({ x: 500, y: 300, radius: 14 }, { x: 500 - 77, y: 300, width: 120, height: 20 });
    expect(left.x1).toBe(486);
    // 牌子在节点左侧：线终于牌子的**右**边缘
    expect(left).toEqual({ x1: 486, y1: 300, x2: 483, y2: 300 });
  });

  it("主轴更斜时按斜的那条边走，不会画出斜穿的长线", () => {
    const line = labelLeader({ x: 0, y: 0, radius: 10 }, { x: 90, y: 12, width: 100, height: 20 });
    expect(line.y1).toBe(0);
    expect(line.y2).toBe(12);
  });

  it("`pinned` 只画整句：装不下就不画，而不是留个省略号", () => {
    expect(isWholeLabel("习惯在图书馆三楼复习", "习惯在图书馆三楼复习")).toBe(true);
    expect(isWholeLabel("  习惯在图书馆三楼复习  ", "习惯在图书馆三楼复习")).toBe(true);
    expect(isWholeLabel("用户明确要求：不要主动催促复习，除非用户主动询问。", "用户明确要求：不要主动…")).toBe(false);
    // 空正文走的是占位名，不是省略号
    expect(isWholeLabel("   ", "未命名对象")).toBe(true);
  });
});
