import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { describe, it } from "node:test";
import {
  STAR_MAP_NODE_RADIUS,
  createUniverseLayout,
  filterUnderstandingGraph,
  findGraphPath,
  getGraphNeighborhood,
  getSelectedGraphPath,
  graphEdgeKey,
  normalizeUnderstandingGraph,
  type GraphEdge,
  type GraphNode,
  type GraphNodeType,
  type UnderstandingGraph,
} from "../understanding-graph";

function node(
  id: string,
  type: GraphNodeType,
  label: string,
  state: string | null = null,
  metadata: Record<string, unknown> = {},
): GraphNode {
  return {
    id,
    entityId: `entity-${id}`,
    type,
    label,
    description: `${label} description`,
    state,
    href: `/${type}/${id}`,
    parentId: null,
    evidenceCoverage: type === "card" ? 0.75 : null,
    hardEvidenceCount: type === "card" ? 2 : 0,
    softEvidenceCount: 0,
    misunderstandingCount: state === "misunderstood" ? 1 : 0,
    lastValidatedAt: null,
    nextReviewAt: null,
    metadata,
  };
}

function edge(id: string, from: string, to: string, type: GraphEdge["type"]): GraphEdge {
  return { id, from, to, type, strength: 1 };
}

function fixture(): UnderstandingGraph {
  return {
    nodes: [
      node("source-a", "source", "Transformer paper"),
      node("note-a", "note", "Attention notes"),
      node("card-a", "card", "Scaled dot-product attention", "misunderstood"),
      node("claim-a", "key_point", "Entropy changes after scaling", null, { alias: "熵" }),
      node("card-sibling", "card", "Multi-head attention", "reviewed"),
      node("claim-sibling", "key_point", "Heads learn different subspaces"),
      node("source-b", "source", "Database book"),
      node("note-b", "note", "Index notes"),
      node("card-b", "card", "B-tree fanout", "reviewed"),
      node("claim-b", "key_point", "Fanout reduces tree height"),
      node("orphan", "note", "Unlinked scratch note"),
    ],
    edges: [
      edge("e-a-1", "source-a", "note-a", "derived_from"),
      edge("e-a-2", "note-a", "card-a", "generated_from"),
      edge("e-a-3", "card-a", "claim-a", "contains"),
      edge("e-a-4", "note-a", "card-sibling", "generated_from"),
      edge("e-a-5", "card-sibling", "claim-sibling", "contains"),
      edge("e-b-1", "source-b", "note-b", "derived_from"),
      edge("e-b-2", "note-b", "card-b", "generated_from"),
      edge("e-b-3", "card-b", "claim-b", "contains"),
    ],
  };
}

describe("understanding graph normalization and filtering", () => {
  it("drops dangling and semantic duplicate edges deterministically", () => {
    const graph = fixture();
    graph.edges.push(
      edge("z-duplicate", "source-a", "note-a", "derived_from"),
      edge("a-duplicate", "source-a", "note-a", "derived_from"),
      edge("dangling", "missing", "note-a", "derived_from"),
    );
    const normalized = normalizeUnderstandingGraph(graph);
    const copies = normalized.edges.filter((item) => graphEdgeKey(item) === "source-a\u0000note-a\u0000derived_from");
    assert.equal(copies.length, 1);
    assert.equal(copies[0].id, "a-duplicate");
    assert.equal(normalized.edges.some((item) => item.id === "dangling"), false);
  });

  it("keeps only a matching card's ancestors and descendants, not its siblings", () => {
    const filtered = filterUnderstandingGraph(fixture(), { state: "misunderstood" });
    assert.deepEqual(filtered.nodes.map((item) => item.id), [
      "source-a",
      "note-a",
      "card-a",
      "claim-a",
    ]);
    assert.equal(filtered.edges.length, 3);
  });

  it("searches labels, descriptions and metadata while retaining traceability", () => {
    const byLabel = filterUnderstandingGraph(fixture(), { query: "entropy" });
    assert.deepEqual(byLabel.nodes.map((item) => item.id), ["source-a", "note-a", "card-a", "claim-a"]);

    const byMetadata = filterUnderstandingGraph(fixture(), { query: "熵" });
    assert.deepEqual(byMetadata.nodes.map((item) => item.id), ["source-a", "note-a", "card-a", "claim-a"]);
  });

  it("matches search text anywhere in a status-filtered card lineage", () => {
    const matching = filterUnderstandingGraph(fixture(), {
      state: "misunderstood",
      query: "Entropy",
    });
    assert.deepEqual(matching.nodes.map((item) => item.id), ["source-a", "note-a", "card-a", "claim-a"]);

    const wrongState = filterUnderstandingGraph(fixture(), {
      state: "reviewed",
      query: "Entropy",
    });
    assert.deepEqual(wrongState, { nodes: [], edges: [] });
  });

  it("uses node type filters as lineage seeds and honors final visibility toggles", () => {
    const result = filterUnderstandingGraph(fixture(), {
      nodeTypes: ["card"],
      state: "reviewed",
      showSources: false,
      showClaims: false,
    });
    assert.deepEqual(result.nodes.map((item) => item.id), ["note-a", "note-b", "card-b", "card-sibling"]);
    assert.deepEqual(result.edges.map((item) => item.id), ["e-a-4", "e-b-2"]);
  });

  it("supports literal context-free results and an empty match", () => {
    const literal = filterUnderstandingGraph(fixture(), {
      query: "Scaled dot-product",
      preserveLineage: false,
    });
    assert.deepEqual(literal.nodes.map((item) => item.id), ["card-a"]);
    assert.deepEqual(literal.edges, []);
    assert.deepEqual(filterUnderstandingGraph(fixture(), { query: "not-present" }), { nodes: [], edges: [] });
  });
});

describe("understanding graph traversal", () => {
  it("returns deterministic one-hop and multi-hop neighborhoods", () => {
    const oneHop = getGraphNeighborhood(fixture(), "note-a");
    assert.deepEqual(oneHop.nodeIds, ["source-a", "note-a", "card-a", "card-sibling"]);

    const outgoing = getGraphNeighborhood(fixture(), "note-a", { direction: "outgoing", depth: 2 });
    assert.deepEqual(outgoing.nodeIds, ["note-a", "card-a", "card-sibling", "claim-a", "claim-sibling"]);
    assert.equal(outgoing.edges.length, 4);
  });

  it("builds selected ancestry and descendant paths", () => {
    const selected = getSelectedGraphPath(fixture(), "card-a");
    assert.deepEqual(selected.selectedIds, ["card-a"]);
    assert.deepEqual(selected.ancestorIds, ["source-a", "note-a"]);
    assert.deepEqual(selected.descendantIds, ["claim-a"]);
    assert.equal(selected.nodes.some((item) => item.id === "card-sibling"), false);
  });

  it("finds shortest paths in traversal order", () => {
    const path = findGraphPath(fixture(), "source-a", "claim-a", "outgoing");
    assert.deepEqual(path?.nodeIds, ["source-a", "note-a", "card-a", "claim-a"]);
    assert.deepEqual(path?.edgeIds, ["e-a-1", "e-a-2", "e-a-3"]);
    assert.equal(findGraphPath(fixture(), "claim-a", "source-a", "outgoing"), null);
    assert.deepEqual(findGraphPath(fixture(), "card-a", "card-a")?.nodeIds, ["card-a"]);
  });

  it("terminates safely for cycles and self-edges", () => {
    const graph = fixture();
    graph.edges.push(
      edge("cycle-1", "card-a", "card-sibling", "generated_from"),
      edge("cycle-2", "card-sibling", "card-a", "generated_from"),
      edge("self", "claim-a", "claim-a", "contains"),
    );
    const neighborhood = getGraphNeighborhood(graph, "card-a", { depth: Number.POSITIVE_INFINITY });
    assert.equal(new Set(neighborhood.nodeIds).size, neighborhood.nodeIds.length);
    assert.ok(neighborhood.nodeIds.length <= graph.nodes.length);

    const selected = getSelectedGraphPath(graph, "card-a");
    assert.equal(new Set(selected.nodeIds).size, selected.nodeIds.length);
    assert.ok(selected.nodeIds.length <= graph.nodes.length);
  });
});

function organicUniverseFixture(componentCount = 14): UnderstandingGraph {
  const graph: UnderstandingGraph = { nodes: [], edges: [] };
  for (let index = 0; index < componentCount; index += 1) {
    const suffix = String(index).padStart(3, "0");
    graph.nodes.push(
      node(`universe-source-${suffix}`, "source", `Source ${suffix}`),
      node(`universe-note-${suffix}`, "note", `Note ${suffix}`),
      node(`universe-card-${suffix}`, "card", `Card ${suffix}`, index % 3 ? "reviewed" : "misunderstood"),
      node(`universe-claim-a-${suffix}`, "key_point", `Claim A ${suffix}`),
      node(`universe-claim-b-${suffix}`, "key_point", `Claim B ${suffix}`),
    );
    graph.edges.push(
      edge(`universe-source-note-${suffix}`, `universe-source-${suffix}`, `universe-note-${suffix}`, "derived_from"),
      edge(`universe-note-card-${suffix}`, `universe-note-${suffix}`, `universe-card-${suffix}`, "generated_from"),
      edge(`universe-card-claim-a-${suffix}`, `universe-card-${suffix}`, `universe-claim-a-${suffix}`, "contains"),
      edge(`universe-card-claim-b-${suffix}`, `universe-card-${suffix}`, `universe-claim-b-${suffix}`, "contains"),
    );
  }
  return graph;
}

function branchedUniverseFixture(claimCount = 18): UnderstandingGraph {
  const graph: UnderstandingGraph = {
    nodes: [
      node("branch-source", "source", "Branch source"),
      node("branch-note", "note", "Branch note"),
      node("branch-card", "card", "Branch card", "seen"),
    ],
    edges: [
      edge("branch-source-note", "branch-source", "branch-note", "derived_from"),
      edge("branch-note-card", "branch-note", "branch-card", "generated_from"),
    ],
  };
  for (let index = 0; index < claimCount; index += 1) {
    const suffix = String(index).padStart(3, "0");
    graph.nodes.push(node(`branch-claim-${suffix}`, "key_point", `Branch claim ${suffix}`));
    graph.edges.push(edge(
      `branch-card-claim-${suffix}`,
      "branch-card",
      `branch-claim-${suffix}`,
      "contains",
    ));
  }
  return graph;
}

function denseUniverseHub(totalNodes = 2_000): UnderstandingGraph {
  return branchedUniverseFixture(Math.max(0, totalNodes - 3));
}

function assertUniverseHasNoTypicalCollisions(graph: UnderstandingGraph) {
  const layout = createUniverseLayout(graph);
  const nodes = normalizeUnderstandingGraph(graph).nodes;
  for (let left = 0; left < nodes.length; left += 1) {
    const leftPoint = layout.positions[nodes[left].id];
    assert.ok(Number.isFinite(leftPoint.x) && Number.isFinite(leftPoint.y));
    for (let right = left + 1; right < nodes.length; right += 1) {
      const rightPoint = layout.positions[nodes[right].id];
      const distance = Math.hypot(leftPoint.x - rightPoint.x, leftPoint.y - rightPoint.y);
      const minimum = STAR_MAP_NODE_RADIUS[nodes[left].type] + STAR_MAP_NODE_RADIUS[nodes[right].type];
      assert.ok(distance >= minimum - 0.001, `${nodes[left].id} overlaps ${nodes[right].id}`);
    }
  }
  return layout;
}

function assertUniverseCollisionFreeLinear(
  graph: UnderstandingGraph,
  layout: ReturnType<typeof createUniverseLayout>,
) {
  const cellSize = 128;
  const buckets = new Map<string, Array<{ id: string; x: number; y: number; radius: number }>>();
  for (const node of normalizeUnderstandingGraph(graph).nodes) {
    const point = layout.positions[node.id];
    const radius = STAR_MAP_NODE_RADIUS[node.type];
    const cellX = Math.floor(point.x / cellSize);
    const cellY = Math.floor(point.y / cellSize);
    for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
      for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
        for (const placed of buckets.get(`${cellX + offsetX}:${cellY + offsetY}`) ?? []) {
          const distance = Math.hypot(point.x - placed.x, point.y - placed.y);
          assert.ok(distance >= radius + placed.radius - 0.001, `${node.id} overlaps ${placed.id}`);
        }
      }
    }
    const key = `${cellX}:${cellY}`;
    const bucket = buckets.get(key) ?? [];
    bucket.push({ id: node.id, ...point, radius });
    buckets.set(key, bucket);
  }
}

describe("organic universe layout", () => {
  it("returns a safe zero-sized universe for an empty graph", () => {
    assert.deepEqual(createUniverseLayout({ nodes: [], edges: [] }), {
      positions: {},
      bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 },
      clusterCenters: {},
    });
  });

  it("is deterministic and independent of API input order", () => {
    const graph = organicUniverseFixture();
    const expected = createUniverseLayout(graph);
    const reversed = createUniverseLayout({
      nodes: [...graph.nodes].reverse(),
      edges: [...graph.edges].reverse(),
    });
    assert.deepEqual(createUniverseLayout(graph), expected);
    assert.deepEqual(reversed, expected);
  });

  it("creates finite organic galaxies with meaningful rendered bounds", () => {
    const graph = organicUniverseFixture();
    const layout = assertUniverseHasNoTypicalCollisions(graph);
    assert.equal(Object.keys(layout.positions).length, graph.nodes.length);
    assert.equal(Object.keys(layout.clusterCenters).length, 14);
    assert.ok(layout.bounds.width > 1000 && layout.bounds.width < 20_000);
    assert.ok(layout.bounds.height > 800 && layout.bounds.height < 20_000);
    assert.ok(Math.abs(layout.bounds.width - (layout.bounds.maxX - layout.bounds.minX)) < 0.001);
    assert.ok(Math.abs(layout.bounds.height - (layout.bounds.maxY - layout.bounds.minY)) < 0.001);

    const uniqueX = new Set(Object.values(layout.positions).map((point) => point.x)).size;
    const uniqueY = new Set(Object.values(layout.positions).map((point) => point.y)).size;
    assert.ok(uniqueX > graph.nodes.length * 0.8, "nodes are not placed in mechanical vertical lanes");
    assert.ok(uniqueY > graph.nodes.length * 0.8, "nodes are not placed in mechanical horizontal rows");

    for (const item of graph.nodes) {
      const point = layout.positions[item.id];
      const radius = STAR_MAP_NODE_RADIUS[item.type];
      assert.ok(point.x - radius >= layout.bounds.minX - 0.001);
      assert.ok(point.x + radius <= layout.bounds.maxX + 0.001);
      assert.ok(point.y - radius >= layout.bounds.minY - 0.001);
      assert.ok(point.y + radius <= layout.bounds.maxY + 0.001);
    }
  });

  it("grows semantic branches as irregular low-discrepancy constellations", () => {
    const graph = branchedUniverseFixture();
    const layout = assertUniverseHasNoTypicalCollisions(graph);
    const card = layout.positions["branch-card"];
    const claims = graph.nodes.filter((item) => item.type === "key_point");
    const polar = claims.map((item) => {
      const point = layout.positions[item.id];
      return {
        distance: Math.hypot(point.x - card.x, point.y - card.y),
        angle: Math.atan2(point.y - card.y, point.x - card.x),
      };
    });

    const distances = polar.map((item) => item.distance);
    assert.ok(
      Math.max(...distances) - Math.min(...distances) > 180,
      "large sibling groups should breathe across multiple organic orbits",
    );
    assert.ok(
      new Set(distances.map((distance) => Math.round(distance / 12))).size >= claims.length / 2,
      "branches should not collapse onto a small set of mechanical rings",
    );

    const angles = polar.map((item) => item.angle < 0 ? item.angle + Math.PI * 2 : item.angle)
      .sort((left, right) => left - right);
    const gaps = angles.map((angle, index) => {
      const next = angles[(index + 1) % angles.length] + (index === angles.length - 1 ? Math.PI * 2 : 0);
      return next - angle;
    });
    assert.ok(Math.max(...gaps) - Math.min(...gaps) > 0.08, "angular spacing should retain natural variation");
  });

  it("anchors the largest knowledge system at the universe core", () => {
    const large = branchedUniverseFixture(28);
    const satellites = organicUniverseFixture(8);
    const layout = createUniverseLayout({
      nodes: [...large.nodes, ...satellites.nodes],
      edges: [...large.edges, ...satellites.edges],
    });
    assert.deepEqual(layout.clusterCenters["branch-card"], { x: 0, y: 0 });
    assert.ok(
      Object.values(layout.clusterCenters).some((point) => Math.hypot(point.x, point.y) > 500),
      "smaller systems should form surrounding knowledge archipelagos",
    );
  });

  it("lays out every raw node despite cycles, self-edges and dangling edges", () => {
    const graph = fixture();
    graph.edges.push(
      edge("universe-cycle-a", "card-a", "card-sibling", "generated_from"),
      edge("universe-cycle-b", "card-sibling", "card-a", "generated_from"),
      edge("universe-self", "claim-a", "claim-a", "contains"),
      edge("universe-dangling", "missing", "card-a", "generated_from"),
    );
    const layout = createUniverseLayout(graph);
    assert.deepEqual(Object.keys(layout.positions).sort(), graph.nodes.map((item) => item.id).sort());
    assert.ok(Object.values(layout.positions).every((point) => Number.isFinite(point.x) && Number.isFinite(point.y)));
    assert.ok(Number.isFinite(layout.bounds.width) && Number.isFinite(layout.bounds.height));
  });

  it("handles two thousand nodes without sacrificing finite coordinates", () => {
    const graph = organicUniverseFixture(400); // 2,000 nodes across 400 galaxies
    const startedAt = performance.now();
    const layout = createUniverseLayout(graph);
    const elapsed = performance.now() - startedAt;
    assert.equal(Object.keys(layout.positions).length, 2_000);
    assert.equal(Object.keys(layout.clusterCenters).length, 400);
    assert.ok(Object.values(layout.positions).every((point) => Number.isFinite(point.x) && Number.isFinite(point.y)));
    assert.ok(elapsed < 750, `2,000-node archipelago layout took ${elapsed.toFixed(1)}ms`);
  });

  it("keeps a two-thousand-node high-fanout galaxy within an interactive budget", () => {
    const graph = denseUniverseHub();
    const startedAt = performance.now();
    const layout = createUniverseLayout(graph);
    const elapsed = performance.now() - startedAt;
    assert.equal(Object.keys(layout.positions).length, 2_000);
    assert.equal(Object.keys(layout.clusterCenters).length, 1);
    assert.ok(Object.values(layout.positions).every((point) => Number.isFinite(point.x) && Number.isFinite(point.y)));
    assertUniverseCollisionFreeLinear(graph, layout);
    assert.ok(elapsed < 750, `2,000-node fanout layout took ${elapsed.toFixed(1)}ms`);
  });
});
