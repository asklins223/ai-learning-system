/**
 * Pure data helpers for the understanding graph.
 *
 * This module deliberately has no React or DOM dependency. The API response can
 * be passed in directly, then filtered and laid out before the UI renders it.
 */

export const GRAPH_NODE_TYPES = ["source", "note", "card", "key_point"] as const;
export const GRAPH_EDGE_TYPES = ["derived_from", "generated_from", "contains"] as const;

export type GraphNodeType = (typeof GRAPH_NODE_TYPES)[number];
export type GraphEdgeType = (typeof GRAPH_EDGE_TYPES)[number];

export interface GraphNode {
  id: string;
  entityId: string;
  type: GraphNodeType;
  label: string;
  description: string | null;
  state: string | null;
  href: string | null;
  parentId: string | null;
  evidenceCoverage: number | null;
  hardEvidenceCount: number;
  softEvidenceCount: number;
  misunderstandingCount: number;
  lastValidatedAt: string | null;
  nextReviewAt: string | null;
  metadata: Record<string, unknown>;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  type: GraphEdgeType;
  strength: number;
}

export interface UnderstandingGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface GraphFilter {
  query?: string;
  state?: string | readonly string[] | null;
  /** Sources can be hidden without breaking the note -> card -> claim chain. */
  showSources?: boolean;
  /** Claims are represented by key_point nodes. */
  showClaims?: boolean;
  /** Matching node types act as seeds; their lineage remains visible. */
  nodeTypes?: readonly GraphNodeType[];
  /** Defaults to true. Disable only for a literal, context-free result set. */
  preserveLineage?: boolean;
}

export type GraphDirection = "incoming" | "outgoing" | "both";

export interface GraphNeighborhoodOptions {
  direction?: GraphDirection;
  /** One hop by default. Infinity walks the complete reachable subgraph. */
  depth?: number;
}

export interface GraphSubgraph extends UnderstandingGraph {
  nodeIds: string[];
  edgeIds: string[];
}

export interface SelectedGraphPath extends GraphSubgraph {
  selectedIds: string[];
  ancestorIds: string[];
  descendantIds: string[];
}

export interface GraphPath extends GraphSubgraph {
  from: string;
  to: string;
}

export interface GraphLayoutOptions {
  width?: number;
  height?: number;
  paddingX?: number;
  paddingY?: number;
  componentGap?: number;
  nodeGap?: number;
}

export interface PositionedGraphNode extends GraphNode {
  /** Top-left position in graph-canvas coordinates. */
  x: number;
  y: number;
  width: number;
  height: number;
  componentId: string;
  laneIndex: number;
  order: number;
}

export interface PositionedGraphEdge extends GraphEdge {
  /** Stable semantic key, also useful as a React key when API edge ids change. */
  key: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  controlX1: number;
  controlY1: number;
  controlX2: number;
  controlY2: number;
  /** Ready for an SVG path `d` attribute. */
  path: string;
}

export interface GraphLayoutComponent {
  id: string;
  nodeIds: string[];
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface UnderstandingGraphLayout {
  width: number;
  height: number;
  scale: number;
  nodes: PositionedGraphNode[];
  edges: PositionedGraphEdge[];
  components: GraphLayoutComponent[];
}

export interface StarMapPoint {
  x: number;
  y: number;
}

export type StarMapLayout = Readonly<Record<string, Readonly<StarMapPoint>>>;

export interface StarMapLayoutOptions {
  width?: number;
  height?: number;
  padding?: number;
  collisionGap?: number;
  /** Candidate lattice resolution. Smaller values pack more tightly but cost more. */
  candidateStep?: number;
}

export interface UniverseBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
}

export interface UniverseLayout {
  positions: Record<string, StarMapPoint>;
  bounds: UniverseBounds;
  /** Keyed by the stable component id (the component's smallest node id). */
  clusterCenters: Record<string, StarMapPoint>;
}

const TYPE_RANK: Record<GraphNodeType, number> = {
  source: 0,
  note: 1,
  card: 2,
  key_point: 3,
};

const NODE_SIZE: Record<GraphNodeType, { width: number; height: number }> = {
  source: { width: 208, height: 72 },
  note: { width: 216, height: 76 },
  card: { width: 228, height: 88 },
  key_point: { width: 210, height: 68 },
};

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const FULL_TURN = Math.PI * 2;

/** Must stay aligned with UnderstandingStarMap's rendered SVG geometry. */
export const STAR_MAP_NODE_RADIUS: Readonly<Record<GraphNodeType, number>> = {
  source: 53,
  note: 51,
  card: 59,
  key_point: 35,
};

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareNodes(left: GraphNode, right: GraphNode) {
  return TYPE_RANK[left.type] - TYPE_RANK[right.type] || compareText(left.id, right.id);
}

export function graphEdgeKey(edge: Pick<GraphEdge, "from" | "to" | "type">) {
  return `${edge.from}\u0000${edge.to}\u0000${edge.type}`;
}

function compareEdges(left: GraphEdge, right: GraphEdge) {
  return compareText(graphEdgeKey(left), graphEdgeKey(right)) || compareText(left.id, right.id);
}

/**
 * Removes malformed references and semantic duplicate edges, and sorts the
 * result. Sorting makes every downstream operation independent of API order.
 */
export function normalizeUnderstandingGraph(graph: UnderstandingGraph): UnderstandingGraph {
  const uniqueNodes = new Map<string, GraphNode>();
  for (const node of [...graph.nodes].sort(compareNodes)) {
    if (node.id && !uniqueNodes.has(node.id)) uniqueNodes.set(node.id, node);
  }

  const nodeIds = new Set(uniqueNodes.keys());
  const uniqueEdges = new Map<string, GraphEdge>();
  for (const edge of [...graph.edges].sort(compareEdges)) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) continue;
    const key = graphEdgeKey(edge);
    if (!uniqueEdges.has(key)) uniqueEdges.set(key, edge);
  }

  return {
    nodes: [...uniqueNodes.values()].sort(compareNodes),
    edges: [...uniqueEdges.values()].sort(compareEdges),
  };
}

interface IndexedGraph {
  graph: UnderstandingGraph;
  nodeById: Map<string, GraphNode>;
  incoming: Map<string, GraphEdge[]>;
  outgoing: Map<string, GraphEdge[]>;
  incident: Map<string, GraphEdge[]>;
}

function indexGraph(input: UnderstandingGraph): IndexedGraph {
  const graph = normalizeUnderstandingGraph(input);
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const incoming = new Map<string, GraphEdge[]>();
  const outgoing = new Map<string, GraphEdge[]>();
  const incident = new Map<string, GraphEdge[]>();

  for (const node of graph.nodes) {
    incoming.set(node.id, []);
    outgoing.set(node.id, []);
    incident.set(node.id, []);
  }
  for (const edge of graph.edges) {
    incoming.get(edge.to)?.push(edge);
    outgoing.get(edge.from)?.push(edge);
    incident.get(edge.from)?.push(edge);
    if (edge.to !== edge.from) incident.get(edge.to)?.push(edge);
  }

  return { graph, nodeById, incoming, outgoing, incident };
}

function graphSubset(indexed: IndexedGraph, nodeIds: Set<string>, edgeKeys?: Set<string>): GraphSubgraph {
  const nodes = indexed.graph.nodes.filter((node) => nodeIds.has(node.id));
  const edges = indexed.graph.edges.filter((edge) => (
    nodeIds.has(edge.from) &&
    nodeIds.has(edge.to) &&
    (!edgeKeys || edgeKeys.has(graphEdgeKey(edge)))
  ));
  return {
    nodes,
    edges,
    nodeIds: nodes.map((node) => node.id),
    edgeIds: edges.map((edge) => edge.id),
  };
}

function flattenSearchValue(value: unknown, seen = new Set<unknown>(), depth = 0): string[] {
  if (value == null || depth > 4) return [];
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return [String(value)];
  }
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  if (Array.isArray(value)) {
    return value.flatMap((item) => flattenSearchValue(item, seen, depth + 1));
  }
  return Object.keys(value as Record<string, unknown>)
    .sort(compareText)
    .flatMap((key) => [key, ...flattenSearchValue((value as Record<string, unknown>)[key], seen, depth + 1)]);
}

function nodeSearchText(node: GraphNode) {
  return [
    node.label,
    node.description ?? "",
    node.state ?? "",
    node.type,
    ...flattenSearchValue(node.metadata),
  ].join(" ").toLocaleLowerCase("zh-CN");
}

interface HierarchyStep {
  edge: GraphEdge;
  parent: string;
  child: string;
}

/** Treat lower-ranked entity types as ancestors even if an API edge is reversed. */
function hierarchyStep(indexed: IndexedGraph, edge: GraphEdge): HierarchyStep {
  const from = indexed.nodeById.get(edge.from);
  const to = indexed.nodeById.get(edge.to);
  if (from && to && TYPE_RANK[from.type] > TYPE_RANK[to.type]) {
    return { edge, parent: edge.to, child: edge.from };
  }
  return { edge, parent: edge.from, child: edge.to };
}

function walkHierarchy(
  indexed: IndexedGraph,
  starts: readonly string[],
  direction: "ancestors" | "descendants",
) {
  const visited = new Set(starts.filter((id) => indexed.nodeById.has(id)));
  const traversed = new Set<string>();
  const queue = [...visited].sort(compareText);

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const edge of indexed.incident.get(current) ?? []) {
      const step = hierarchyStep(indexed, edge);
      const next = direction === "ancestors"
        ? (step.child === current ? step.parent : null)
        : (step.parent === current ? step.child : null);
      if (!next) continue;
      traversed.add(graphEdgeKey(edge));
      if (visited.has(next)) continue;
      visited.add(next);
      queue.push(next);
      queue.sort(compareText);
    }
  }

  return { nodeIds: visited, edgeKeys: traversed };
}

/**
 * Returns selected nodes plus their complete source -> note -> card -> claim
 * lineage. Visited sets make this safe for self-edges and cyclic data.
 */
export function getSelectedGraphPath(
  graph: UnderstandingGraph,
  selected: string | readonly string[],
): SelectedGraphPath {
  const indexed = indexGraph(graph);
  const requested = typeof selected === "string" ? [selected] : [...selected];
  const selectedIds = [...new Set(requested)]
    .filter((id) => indexed.nodeById.has(id))
    .sort(compareText);
  const ancestors = walkHierarchy(indexed, selectedIds, "ancestors");
  const descendants = walkHierarchy(indexed, selectedIds, "descendants");
  const nodeIds = new Set([...ancestors.nodeIds, ...descendants.nodeIds]);
  const edgeKeys = new Set([...ancestors.edgeKeys, ...descendants.edgeKeys]);
  const subset = graphSubset(indexed, nodeIds, edgeKeys);
  const selectedSet = new Set(selectedIds);

  return {
    ...subset,
    selectedIds,
    ancestorIds: subset.nodeIds.filter((id) => ancestors.nodeIds.has(id) && !selectedSet.has(id)),
    descendantIds: subset.nodeIds.filter((id) => descendants.nodeIds.has(id) && !selectedSet.has(id)),
  };
}

/** Alias kept short for UI call sites. */
export const getSelectedPath = getSelectedGraphPath;

/**
 * Filters matching seeds while retaining their lineage for traceability.
 * `showSources` and `showClaims` are final visibility toggles, so they always
 * win over lineage preservation.
 */
export function filterUnderstandingGraph(
  graph: UnderstandingGraph,
  filter: GraphFilter = {},
): UnderstandingGraph {
  const indexed = indexGraph(graph);
  const query = filter.query?.trim().toLocaleLowerCase("zh-CN") ?? "";
  const states = new Set(
    (Array.isArray(filter.state) ? filter.state : filter.state ? [filter.state] : [])
      .filter((state) => state !== "all"),
  );
  const nodeTypes = new Set(filter.nodeTypes ?? []);
  const hasSeedFilter = Boolean(query || states.size > 0 || nodeTypes.size > 0);

  const queryMatches = new Set(
    query
      ? indexed.graph.nodes.filter((node) => nodeSearchText(node).includes(query)).map((node) => node.id)
      : indexed.graph.nodes.map((node) => node.id),
  );
  let seedNodes = indexed.graph.nodes
    .filter((node) => states.size === 0 || (node.type === "card" && node.state != null && states.has(node.state)))
    .filter((node) => nodeTypes.size === 0 || nodeTypes.has(node.type));

  if (query) {
    if (states.size === 0 && nodeTypes.size === 0) {
      seedNodes = seedNodes.filter((node) => queryMatches.has(node.id));
    } else {
      // A status/type filter normally selects cards or entity kinds. Let the
      // search term match anywhere on each candidate's lineage, so searching a
      // claim while "有误解" is active still finds its misunderstood card.
      seedNodes = seedNodes.filter((node) => {
        const ancestors = walkHierarchy(indexed, [node.id], "ancestors").nodeIds;
        const descendants = walkHierarchy(indexed, [node.id], "descendants").nodeIds;
        return [...ancestors, ...descendants].some((id) => queryMatches.has(id));
      });
    }
  }
  const seedIds = seedNodes.map((node) => node.id);

  let visibleIds: Set<string>;
  if (!hasSeedFilter) {
    visibleIds = new Set(indexed.graph.nodes.map((node) => node.id));
  } else if (filter.preserveLineage === false) {
    visibleIds = new Set(seedIds);
  } else {
    visibleIds = new Set(getSelectedGraphPath(indexed.graph, seedIds).nodeIds);
  }

  if (filter.showSources === false) {
    for (const node of indexed.graph.nodes) {
      if (node.type === "source") visibleIds.delete(node.id);
    }
  }
  if (filter.showClaims === false) {
    for (const node of indexed.graph.nodes) {
      if (node.type === "key_point") visibleIds.delete(node.id);
    }
  }

  const subset = graphSubset(indexed, visibleIds);
  return { nodes: subset.nodes, edges: subset.edges };
}

export function getGraphNeighborhood(
  graph: UnderstandingGraph,
  nodeId: string,
  options: GraphNeighborhoodOptions = {},
): GraphSubgraph {
  const indexed = indexGraph(graph);
  if (!indexed.nodeById.has(nodeId)) return graphSubset(indexed, new Set());

  const direction = options.direction ?? "both";
  const requestedDepth = options.depth ?? 1;
  const depth = Number.isFinite(requestedDepth)
    ? Math.max(0, Math.floor(requestedDepth))
    : Number.POSITIVE_INFINITY;
  const visited = new Set([nodeId]);
  const edgeKeys = new Set<string>();
  let frontier = [nodeId];
  let distance = 0;

  while (frontier.length > 0 && distance < depth) {
    const nextFrontier = new Set<string>();
    for (const current of frontier.sort(compareText)) {
      const edges = direction === "incoming"
        ? indexed.incoming.get(current) ?? []
        : direction === "outgoing"
          ? indexed.outgoing.get(current) ?? []
          : indexed.incident.get(current) ?? [];
      for (const edge of edges) {
        const next = direction === "incoming"
          ? edge.from
          : direction === "outgoing"
            ? edge.to
            : edge.from === current ? edge.to : edge.from;
        edgeKeys.add(graphEdgeKey(edge));
        if (!visited.has(next)) {
          visited.add(next);
          nextFrontier.add(next);
        }
      }
    }
    frontier = [...nextFrontier];
    distance += 1;
  }

  return graphSubset(indexed, visited, edgeKeys);
}

/** Alias for consumers that prefer the shorter name. */
export const getGraphNeighbors = getGraphNeighborhood;

/** Deterministic shortest path; defaults to treating relationships as undirected. */
export function findGraphPath(
  graph: UnderstandingGraph,
  from: string,
  to: string,
  direction: GraphDirection = "both",
): GraphPath | null {
  const indexed = indexGraph(graph);
  if (!indexed.nodeById.has(from) || !indexed.nodeById.has(to)) return null;
  if (from === to) {
    const subset = graphSubset(indexed, new Set([from]), new Set());
    return { ...subset, from, to };
  }

  const queue = [from];
  const visited = new Set([from]);
  const previous = new Map<string, { nodeId: string; edge: GraphEdge }>();

  while (queue.length > 0 && !visited.has(to)) {
    const current = queue.shift()!;
    const candidates = direction === "incoming"
      ? indexed.incoming.get(current) ?? []
      : direction === "outgoing"
        ? indexed.outgoing.get(current) ?? []
        : indexed.incident.get(current) ?? [];

    for (const edge of [...candidates].sort(compareEdges)) {
      const next = direction === "incoming"
        ? edge.from
        : direction === "outgoing"
          ? edge.to
          : edge.from === current ? edge.to : edge.from;
      if (visited.has(next)) continue;
      visited.add(next);
      previous.set(next, { nodeId: current, edge });
      queue.push(next);
      if (next === to) break;
    }
  }

  if (!visited.has(to)) return null;
  const pathNodeIds = [to];
  const pathEdges: GraphEdge[] = [];
  let current = to;
  while (current !== from) {
    const step = previous.get(current);
    if (!step) return null;
    pathEdges.push(step.edge);
    current = step.nodeId;
    pathNodeIds.push(current);
  }
  pathNodeIds.reverse();
  pathEdges.reverse();
  const nodeSet = new Set(pathNodeIds);
  const edgeSet = new Set(pathEdges.map(graphEdgeKey));
  const subset = graphSubset(indexed, nodeSet, edgeSet);
  return {
    ...subset,
    // Preserve traversal order in paths rather than canonical graph order.
    nodeIds: pathNodeIds,
    edgeIds: pathEdges.map((edge) => edge.id),
    nodes: pathNodeIds.map((id) => indexed.nodeById.get(id)!),
    edges: pathEdges,
    from,
    to,
  };
}

function weaklyConnectedComponents(indexed: IndexedGraph) {
  const visited = new Set<string>();
  const components: string[][] = [];

  const starts = indexed.graph.nodes.map((node) => node.id).sort(compareText);
  for (const start of starts) {
    if (visited.has(start)) continue;
    const component = new Set([start]);
    const queue = [start];
    let queueIndex = 0;
    visited.add(start);

    while (queueIndex < queue.length) {
      const current = queue[queueIndex];
      queueIndex += 1;
      for (const edge of indexed.incident.get(current) ?? []) {
        const next = edge.from === current ? edge.to : edge.from;
        if (component.has(next)) continue;
        component.add(next);
        visited.add(next);
        queue.push(next);
      }
    }
    components.push([...component].sort(compareText));
  }

  return components.sort((left, right) => compareText(left[0], right[0]));
}

function finitePositive(value: number | undefined, fallback: number) {
  return value != null && Number.isFinite(value) && value > 0 ? value : fallback;
}

function rounded(value: number) {
  return Math.round(value * 1000) / 1000;
}

/**
 * Places weakly-connected components in vertical bands and entity types in four
 * fixed semantic lanes. If the graph is dense, node geometry scales uniformly
 * so every rectangle still fits inside the requested canvas without overlap.
 */
export function layoutUnderstandingGraph(
  graph: UnderstandingGraph,
  options: GraphLayoutOptions = {},
): UnderstandingGraphLayout {
  const width = finitePositive(options.width, 1600);
  const height = finitePositive(options.height, 960);
  const paddingX = Math.min(finitePositive(options.paddingX, 64), width / 3);
  const paddingY = Math.min(finitePositive(options.paddingY, 48), height / 3);
  const componentGap = finitePositive(options.componentGap, 32);
  const nodeGap = finitePositive(options.nodeGap, 18);
  const indexed = indexGraph(graph);

  if (indexed.graph.nodes.length === 0) {
    return { width, height, scale: 1, nodes: [], edges: [], components: [] };
  }

  const componentNodeIds = weaklyConnectedComponents(indexed);
  const componentRequirements = componentNodeIds.map((ids) => {
    const nodes = ids.map((id) => indexed.nodeById.get(id)!);
    const byType = GRAPH_NODE_TYPES.map((type) => nodes.filter((node) => node.type === type));
    const heightRequired = Math.max(...byType.map((lane) => (
      lane.reduce((sum, node) => sum + NODE_SIZE[node.type].height, 0) +
      Math.max(0, lane.length - 1) * nodeGap
    )));
    return { ids, nodes, byType, heightRequired: Math.max(heightRequired, 1) };
  });

  const innerWidth = Math.max(1, width - 2 * paddingX);
  const innerHeight = Math.max(1, height - 2 * paddingY);
  const baseLaneWidth = GRAPH_NODE_TYPES.reduce((sum, type) => sum + NODE_SIZE[type].width, 0);
  const minimumLaneGaps = 3 * 36;
  const totalBaseHeight = componentRequirements.reduce((sum, component) => sum + component.heightRequired, 0) +
    Math.max(0, componentRequirements.length - 1) * componentGap;
  const scale = Math.min(
    1,
    innerWidth / (baseLaneWidth + minimumLaneGaps),
    innerHeight / Math.max(1, totalBaseHeight),
  );

  const scaledLaneWidths = GRAPH_NODE_TYPES.map((type) => NODE_SIZE[type].width * scale);
  const remainingLaneSpace = Math.max(0, innerWidth - scaledLaneWidths.reduce((sum, item) => sum + item, 0));
  const laneGap = remainingLaneSpace / 3;
  const laneX: number[] = [];
  let cursorX = paddingX;
  for (let index = 0; index < GRAPH_NODE_TYPES.length; index += 1) {
    laneX.push(cursorX);
    cursorX += scaledLaneWidths[index] + (index < 3 ? laneGap : 0);
  }

  const positionedNodes: PositionedGraphNode[] = [];
  const components: GraphLayoutComponent[] = [];
  let cursorY = paddingY;

  for (const component of componentRequirements) {
    const componentHeight = component.heightRequired * scale;
    const componentId = component.ids[0];
    const currentNodes: PositionedGraphNode[] = [];

    for (let laneIndex = 0; laneIndex < GRAPH_NODE_TYPES.length; laneIndex += 1) {
      const lane = [...component.byType[laneIndex]].sort(compareNodes);
      const laneContentHeight = lane.reduce((sum, node) => sum + NODE_SIZE[node.type].height * scale, 0) +
        Math.max(0, lane.length - 1) * nodeGap * scale;
      let laneY = cursorY + (componentHeight - laneContentHeight) / 2;

      lane.forEach((node, order) => {
        const nodeWidth = NODE_SIZE[node.type].width * scale;
        const nodeHeight = NODE_SIZE[node.type].height * scale;
        const positioned: PositionedGraphNode = {
          ...node,
          x: rounded(laneX[laneIndex]),
          y: rounded(laneY),
          width: rounded(nodeWidth),
          height: rounded(nodeHeight),
          componentId,
          laneIndex,
          order,
        };
        currentNodes.push(positioned);
        positionedNodes.push(positioned);
        laneY += nodeHeight + nodeGap * scale;
      });
    }

    const minX = currentNodes.length > 0 ? Math.min(...currentNodes.map((node) => node.x)) : paddingX;
    const maxX = currentNodes.length > 0
      ? Math.max(...currentNodes.map((node) => node.x + node.width))
      : paddingX;
    components.push({
      id: componentId,
      nodeIds: component.ids,
      x: rounded(minX),
      y: rounded(cursorY),
      width: rounded(maxX - minX),
      height: rounded(componentHeight),
    });
    cursorY += componentHeight + componentGap * scale;
  }

  positionedNodes.sort(compareNodes);
  const positionedById = new Map(positionedNodes.map((node) => [node.id, node]));
  const positionedEdges: PositionedGraphEdge[] = indexed.graph.edges.map((edge) => {
    const from = positionedById.get(edge.from)!;
    const to = positionedById.get(edge.to)!;
    let x1: number;
    let y1: number;
    let x2: number;
    let y2: number;

    if (from.laneIndex < to.laneIndex) {
      x1 = from.x + from.width;
      y1 = from.y + from.height / 2;
      x2 = to.x;
      y2 = to.y + to.height / 2;
    } else if (from.laneIndex > to.laneIndex) {
      x1 = from.x;
      y1 = from.y + from.height / 2;
      x2 = to.x + to.width;
      y2 = to.y + to.height / 2;
    } else {
      x1 = from.x + from.width / 2;
      x2 = to.x + to.width / 2;
      if (from.y <= to.y) {
        y1 = from.y + from.height;
        y2 = to.y;
      } else {
        y1 = from.y;
        y2 = to.y + to.height;
      }
    }

    const horizontal = Math.abs(x2 - x1) >= Math.abs(y2 - y1);
    const controlX1 = horizontal ? x1 + (x2 - x1) * 0.45 : x1;
    const controlY1 = horizontal ? y1 : y1 + (y2 - y1) * 0.45;
    const controlX2 = horizontal ? x2 - (x2 - x1) * 0.45 : x2;
    const controlY2 = horizontal ? y2 : y2 - (y2 - y1) * 0.45;
    const values = [x1, y1, x2, y2, controlX1, controlY1, controlX2, controlY2].map(rounded);

    return {
      ...edge,
      key: graphEdgeKey(edge),
      x1: values[0],
      y1: values[1],
      x2: values[2],
      y2: values[3],
      controlX1: values[4],
      controlY1: values[5],
      controlX2: values[6],
      controlY2: values[7],
      path: `M ${values[0]} ${values[1]} C ${values[4]} ${values[5]}, ${values[6]} ${values[7]}, ${values[2]} ${values[3]}`,
    };
  });

  return {
    width,
    height,
    scale: rounded(scale),
    nodes: positionedNodes,
    edges: positionedEdges,
    components,
  };
}

/** Alias matching the common verb-first call-site style. */
export const createUnderstandingGraphLayout = layoutUnderstandingGraph;

interface StarPlacement {
  node: GraphNode;
  point: StarMapPoint;
}

function starComponentTargets(componentCount: number, width: number, height: number, padding: number) {
  const innerWidth = Math.max(1, width - padding * 2);
  const innerHeight = Math.max(1, height - padding * 2);
  const aspect = innerWidth / innerHeight;
  const columns = Math.max(1, Math.ceil(Math.sqrt(componentCount * aspect)));
  const rows = Math.max(1, Math.ceil(componentCount / columns));
  const cellWidth = innerWidth / columns;
  const cellHeight = innerHeight / rows;

  return Array.from({ length: componentCount }, (_, index) => ({
    x: padding + (index % columns + 0.5) * cellWidth,
    y: padding + (Math.floor(index / columns) + 0.5) * cellHeight,
  }));
}

function starDesiredPoints(
  nodes: readonly GraphNode[],
  target: StarMapPoint,
): Array<{ node: GraphNode; desired: StarMapPoint }> {
  const lanes = GRAPH_NODE_TYPES
    .map((type) => nodes.filter((node) => node.type === type).sort(compareNodes))
    .filter((lane) => lane.length > 0);
  if (lanes.length === 0) return [];

  const ranks = lanes.map((lane) => TYPE_RANK[lane[0].type]);
  const centerRank = (Math.min(...ranks) + Math.max(...ranks)) / 2;
  const rankSpacing = 132;

  return lanes.flatMap((lane) => {
    const type = lane[0].type;
    const verticalSpacing = STAR_MAP_NODE_RADIUS[type] * 2 + 18;
    return lane.map((node, index) => ({
      node,
      desired: {
        x: target.x + (TYPE_RANK[type] - centerRank) * rankSpacing,
        y: target.y + (index - (lane.length - 1) / 2) * verticalSpacing,
      },
    }));
  });
}

function canPlaceStarNode(
  node: GraphNode,
  point: StarMapPoint,
  placed: readonly StarPlacement[],
  gap: number,
) {
  const radius = STAR_MAP_NODE_RADIUS[node.type];
  return placed.every((item) => {
    const minimum = radius + STAR_MAP_NODE_RADIUS[item.node.type] + gap;
    return Math.hypot(point.x - item.point.x, point.y - item.point.y) >= minimum - 0.0001;
  });
}

function buildStarCandidateGrid(width: number, height: number, step: number) {
  const candidates: StarMapPoint[] = [];
  let row = 0;
  for (let y = 0; y <= height; y += step) {
    const offset = row % 2 === 0 ? 0 : step / 2;
    for (let x = offset; x <= width; x += step) candidates.push({ x, y });
    row += 1;
  }
  return candidates;
}

function attemptStarPlacement(
  desiredNodes: ReadonlyArray<{ node: GraphNode; desired: StarMapPoint }>,
  candidates: readonly StarMapPoint[],
  width: number,
  height: number,
  padding: number,
  gap: number,
): StarPlacement[] | null {
  const placed: StarPlacement[] = [];

  for (const { node, desired } of desiredNodes) {
    const radius = STAR_MAP_NODE_RADIUS[node.type];
    const minX = padding + radius;
    const maxX = width - padding - radius;
    const minY = padding + radius;
    const maxY = height - padding - radius;
    const preferred = {
      x: Math.min(maxX, Math.max(minX, desired.x)),
      y: Math.min(maxY, Math.max(minY, desired.y)),
    };

    let best: StarMapPoint | null = canPlaceStarNode(node, preferred, placed, gap) ? preferred : null;
    let bestDistance = best ? 0 : Number.POSITIVE_INFINITY;

    if (!best) {
      for (const candidate of candidates) {
        if (candidate.x < minX || candidate.x > maxX || candidate.y < minY || candidate.y > maxY) continue;
        const distance = (candidate.x - preferred.x) ** 2 + (candidate.y - preferred.y) ** 2;
        if (distance >= bestDistance) continue;
        if (!canPlaceStarNode(node, candidate, placed, gap)) continue;
        best = candidate;
        bestDistance = distance;
      }
    }
    if (!best) return null;
    placed.push({ node, point: { x: rounded(best.x), y: rounded(best.y) } });
  }
  return placed;
}

/**
 * Produces the center-point contract consumed by UnderstandingStarMap.
 *
 * Unlike the rectangle layout above, SVG node radii remain fixed at every zoom
 * level. Components receive stable grid anchors, then nodes are placed on a
 * deterministic collision-free lattice near their semantic lane target. The
 * packing gap is reduced only when sources/claims make the canvas unusually
 * dense; circles themselves are never intentionally overlapped.
 */
export function createStarMapLayout(
  graph: UnderstandingGraph,
  options: StarMapLayoutOptions = {},
): StarMapLayout {
  const width = finitePositive(options.width, 1600);
  const height = finitePositive(options.height, 960);
  const padding = Math.min(finitePositive(options.padding, 18), Math.min(width, height) / 4);
  const requestedGap = Math.max(0, options.collisionGap ?? 16);
  const candidateStep = Math.max(8, finitePositive(options.candidateStep, 14));
  const indexed = indexGraph(graph);
  if (indexed.graph.nodes.length === 0) return {};

  const components = weaklyConnectedComponents(indexed);
  const targets = starComponentTargets(components.length, width, height, padding);
  const desiredNodes = components.flatMap((ids, index) => (
    starDesiredPoints(ids.map((id) => indexed.nodeById.get(id)!), targets[index])
  ));
  const candidates = buildStarCandidateGrid(width, height, candidateStep);
  const gaps = [...new Set([
    requestedGap,
    Math.min(requestedGap, 10),
    Math.min(requestedGap, 4),
    0,
  ])];

  let placed: StarPlacement[] | null = null;
  for (const gap of gaps) {
    placed = attemptStarPlacement(desiredNodes, candidates, width, height, padding, gap);
    if (placed) break;
  }

  if (!placed) {
    // An impossibly dense graph cannot fit fixed-radius circles in a fixed
    // canvas. Keep all nodes addressable with deterministic best-effort points;
    // ordinary product limits should be resolved by one of the attempts above.
    placed = desiredNodes.map(({ node, desired }) => {
      const radius = STAR_MAP_NODE_RADIUS[node.type];
      return {
        node,
        point: {
          x: rounded(Math.min(width - padding - radius, Math.max(padding + radius, desired.x))),
          y: rounded(Math.min(height - padding - radius, Math.max(padding + radius, desired.y))),
        },
      };
    });
  }

  return Object.fromEntries(
    placed
      .sort((left, right) => compareNodes(left.node, right.node))
      .map((item) => [item.node.id, item.point]),
  );
}

interface UniverseCircle extends StarMapPoint {
  id: string;
  radius: number;
}

interface UniverseSpatialIndex {
  cellSize: number;
  maxRadius: number;
  buckets: Map<string, UniverseCircle[]>;
}

interface LocalUniverseCluster {
  id: string;
  positions: Map<string, StarMapPoint>;
  radius: number;
}

function hashString(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function hashUnit(value: string) {
  return hashString(value) / 0xffffffff;
}

function hashRange(value: string, minimum: number, maximum: number) {
  return minimum + hashUnit(value) * (maximum - minimum);
}

function spatialBucketKey(x: number, y: number, cellSize: number) {
  return `${Math.floor(x / cellSize)}:${Math.floor(y / cellSize)}`;
}

function createUniverseSpatialIndex(cellSize: number): UniverseSpatialIndex {
  return { cellSize, maxRadius: 0, buckets: new Map() };
}

function insertUniverseCircle(index: UniverseSpatialIndex, circle: UniverseCircle) {
  const key = spatialBucketKey(circle.x, circle.y, index.cellSize);
  const bucket = index.buckets.get(key) ?? [];
  bucket.push(circle);
  index.buckets.set(key, bucket);
  index.maxRadius = Math.max(index.maxRadius, circle.radius);
}

function universeCircleFits(
  index: UniverseSpatialIndex,
  point: StarMapPoint,
  radius: number,
  gap: number,
) {
  if (index.buckets.size === 0) return true;
  const range = Math.ceil((radius + index.maxRadius + gap) / index.cellSize);
  const centerX = Math.floor(point.x / index.cellSize);
  const centerY = Math.floor(point.y / index.cellSize);

  for (let offsetY = -range; offsetY <= range; offsetY += 1) {
    for (let offsetX = -range; offsetX <= range; offsetX += 1) {
      const bucket = index.buckets.get(`${centerX + offsetX}:${centerY + offsetY}`);
      if (!bucket) continue;
      for (const circle of bucket) {
        const minimum = radius + circle.radius + gap;
        const deltaX = point.x - circle.x;
        const deltaY = point.y - circle.y;
        const threshold = minimum - 0.0001;
        if (deltaX * deltaX + deltaY * deltaY < threshold * threshold) return false;
      }
    }
  }
  return true;
}

function universeParentCandidates(indexed: IndexedGraph, node: GraphNode) {
  const unique = new Map<string, GraphNode>();
  for (const edge of indexed.incident.get(node.id) ?? []) {
    const candidate = indexed.nodeById.get(edge.from === node.id ? edge.to : edge.from);
    if (candidate && TYPE_RANK[candidate.type] < TYPE_RANK[node.type]) {
      unique.set(candidate.id, candidate);
    }
  }

  const explicit = node.parentId ? indexed.nodeById.get(node.parentId) : undefined;
  if (explicit && TYPE_RANK[explicit.type] < TYPE_RANK[node.type]) {
    unique.set(explicit.id, explicit);
  }

  return [...unique.values()].sort((left, right) => (
    TYPE_RANK[right.type] - TYPE_RANK[left.type] || compareText(left.id, right.id)
  ));
}

function placeUniversePoint(
  node: GraphNode,
  desired: StarMapPoint,
  ordinal: number,
  index: UniverseSpatialIndex,
  gap: number,
) {
  const radius = STAR_MAP_NODE_RADIUS[node.type];
  if (universeCircleFits(index, desired, radius, gap)) return desired;

  const phase = hashRange(`${node.id}:collision`, 0, FULL_TURN);
  const searchStep = Math.max(18, radius * 0.42 + gap * 0.52);
  for (let attempt = 1; attempt <= 112; attempt += 1) {
    const wave = Math.sin(phase * 1.7 + attempt * 0.71);
    const distance = searchStep * Math.sqrt(attempt) * (1 + wave * 0.07);
    const angle = phase + attempt * GOLDEN_ANGLE + wave * 0.14;
    const candidate = {
      x: desired.x + Math.cos(angle) * distance * 1.04,
      y: desired.y + Math.sin(angle) * distance * 0.96,
    };
    if (universeCircleFits(index, candidate, radius, gap)) return candidate;
  }

  // Dense constellations fall back to an expanding component-wide phyllotaxis
  // spiral. This remains O(1) per candidate through the spatial hash.
  const fallbackPhase = hashRange(`${node.id}:fallback`, 0, FULL_TURN);
  for (let attempt = 0; attempt < 640; attempt += 1) {
    const step = ordinal + attempt + 1;
    const distance = 74 * Math.sqrt(step);
    const angle = fallbackPhase + step * GOLDEN_ANGLE;
    const candidate = {
      x: Math.cos(angle) * distance,
      y: Math.sin(angle) * distance,
    };
    if (universeCircleFits(index, candidate, radius, gap)) return candidate;
  }

  // Only mathematically impossible densities reach this deterministic fallback.
  const distance = 90 * Math.sqrt(ordinal + 641);
  const angle = fallbackPhase + (ordinal + 641) * GOLDEN_ANGLE;
  return { x: Math.cos(angle) * distance, y: Math.sin(angle) * distance };
}

function layoutLocalUniverseCluster(indexed: IndexedGraph, nodeIds: readonly string[]): LocalUniverseCluster {
  const nodes = nodeIds.map((id) => indexed.nodeById.get(id)!).sort(compareNodes);
  const componentIds = new Set(nodeIds);
  const parentById = new Map<string, GraphNode>();
  const parentsById = new Map<string, GraphNode[]>();
  const childrenByParent = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    const parents = universeParentCandidates(indexed, node)
      .filter((candidate) => componentIds.has(candidate.id));
    parentsById.set(node.id, parents);
    const parent = parents[0];
    if (!parent || !componentIds.has(parent.id)) continue;
    parentById.set(node.id, parent);
    const children = childrenByParent.get(parent.id) ?? [];
    children.push(node);
    childrenByParent.set(parent.id, children);
  }
  const componentSeed = nodeIds[0];
  const compareNaturalOrder = (left: GraphNode, right: GraphNode) => (
    hashString(`${componentSeed}:${left.id}:order`) - hashString(`${componentSeed}:${right.id}:order`) ||
    compareNodes(left, right)
  );
  for (const children of childrenByParent.values()) children.sort(compareNaturalOrder);

  const placementNodes = [...nodes].sort((left, right) => (
    TYPE_RANK[left.type] - TYPE_RANK[right.type] || compareNaturalOrder(left, right)
  ));
  const roots = placementNodes.filter((node) => !parentById.has(node.id));
  const rootIndex = new Map(roots.map((node, index) => [node.id, index]));
  const siblingIndex = new Map<string, number>();
  for (const children of childrenByParent.values()) {
    children.forEach((child, index) => siblingIndex.set(child.id, index));
  }
  const positions = new Map<string, StarMapPoint>();
  const headingById = new Map<string, number>();
  const depthById = new Map<string, number>();
  const spatial = createUniverseSpatialIndex(128);
  const collisionGap = nodes.length > 320 ? 9 : nodes.length > 120 ? 12 : 16;
  const rootPhase = hashRange(`${componentSeed}:root-phase`, 0, FULL_TURN);

  placementNodes.forEach((node, ordinal) => {
    const parent = parentById.get(node.id);
    let desired: StarMapPoint;
    if (!parent || !positions.has(parent.id)) {
      const index = rootIndex.get(node.id) ?? ordinal;
      const turbulence = Math.sin((index + 1) * 1.37 + rootPhase) * 0.21;
      const angle = rootPhase + index * GOLDEN_ANGLE + turbulence +
        hashRange(`${node.id}:root-angle`, -0.24, 0.24);
      const distance = index === 0
        ? 0
        : 116 * Math.sqrt(index) * hashRange(`${node.id}:root-distance`, 0.82, 1.2);
      desired = {
        x: Math.cos(angle) * distance * 1.06,
        y: Math.sin(angle) * distance * 0.94,
      };
      headingById.set(node.id, angle + hashRange(`${node.id}:root-heading`, -0.38, 0.38));
      depthById.set(node.id, 0);
    } else {
      const parentPoint = positions.get(parent.id)!;
      const siblings = childrenByParent.get(parent.id) ?? [node];
      const childIndex = siblingIndex.get(node.id) ?? 0;
      const parentDepth = depthById.get(parent.id) ?? 0;
      const depth = parentDepth + 1;
      const parentAngle = headingById.get(parent.id) ??
        hashRange(`${parent.id}:bearing`, 0, FULL_TURN);
      let angularOffset: number;
      if (siblings.length > 5) {
        angularOffset = childIndex * GOLDEN_ANGLE +
          Math.sin(childIndex * 1.19 + parentAngle) * 0.18;
      } else {
        const spread = Math.min(2.5, 0.74 * Math.max(1, siblings.length - 1));
        angularOffset = siblings.length === 1
          ? hashRange(`${node.id}:bend`, -0.52, 0.52)
          : (childIndex / (siblings.length - 1) - 0.5) * spread +
            hashRange(`${node.id}:fan-jitter`, -0.19, 0.19);
      }
      const curl = Math.sin(depth * 1.11 + hashRange(`${componentSeed}:curl`, 0, FULL_TURN)) * 0.12;
      const angle = parentAngle + angularOffset + curl +
        hashRange(`${node.id}:orbit`, -0.16, 0.16);
      const rankDelta = Math.max(1, TYPE_RANK[node.type] - TYPE_RANK[parent.type]);
      const baseDistance = node.type === "key_point" ? 132 : node.type === "card" ? 178 : 166;
      const crowdingAllowance = siblings.length > 5
        ? 0
        : Math.min(54, Math.sqrt(Math.max(0, siblings.length - 1)) * 12);
      const fanoutSpread = siblings.length > 5
        ? (STAR_MAP_NODE_RADIUS[node.type] * 1.85 + 24) * Math.sqrt(childIndex)
        : 0;
      const distance = baseDistance + crowdingAllowance + fanoutSpread + (rankDelta - 1) * 38 +
        hashRange(`${node.id}:distance`, -22, 27);
      const tangentWarp = hashRange(`${node.id}:tangent`, -20, 20);
      desired = {
        x: parentPoint.x + Math.cos(angle) * distance - Math.sin(angle) * tangentWarp,
        y: parentPoint.y + Math.sin(angle) * distance + Math.cos(angle) * tangentWarp,
      };

      // Multiple provenance links gently pull a star toward the barycenter of
      // its other already-placed parents. This preserves the primary semantic
      // branch while making cross-linked knowledge look like a network rather
      // than a collection of identical radial trees.
      const secondaryPoints = (parentsById.get(node.id) ?? [])
        .slice(1)
        .map((candidate) => positions.get(candidate.id))
        .filter((point): point is StarMapPoint => Boolean(point));
      if (secondaryPoints.length > 0) {
        const average = secondaryPoints.reduce(
          (sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }),
          { x: 0, y: 0 },
        );
        average.x /= secondaryPoints.length;
        average.y /= secondaryPoints.length;
        desired.x = desired.x * 0.78 + average.x * 0.22;
        desired.y = desired.y * 0.78 + average.y * 0.22;
      }
      headingById.set(node.id, angle);
      depthById.set(node.id, depth);
    }

    const point = placeUniversePoint(node, desired, ordinal, spatial, collisionGap);
    const roundedPoint = { x: rounded(point.x), y: rounded(point.y) };
    positions.set(node.id, roundedPoint);
    insertUniverseCircle(spatial, {
      id: node.id,
      ...roundedPoint,
      radius: STAR_MAP_NODE_RADIUS[node.type],
    });
  });

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const node of nodes) {
    const point = positions.get(node.id)!;
    const radius = STAR_MAP_NODE_RADIUS[node.type];
    minX = Math.min(minX, point.x - radius);
    minY = Math.min(minY, point.y - radius);
    maxX = Math.max(maxX, point.x + radius);
    maxY = Math.max(maxY, point.y + radius);
  }
  const center = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
  let clusterRadius = 0;
  for (const node of nodes) {
    const point = positions.get(node.id)!;
    point.x = rounded(point.x - center.x);
    point.y = rounded(point.y - center.y);
    clusterRadius = Math.max(
      clusterRadius,
      Math.hypot(point.x, point.y) + STAR_MAP_NODE_RADIUS[node.type],
    );
  }

  return {
    id: nodeIds[0],
    positions,
    radius: rounded(clusterRadius + 18),
  };
}

function placeUniverseClusters(clusters: readonly LocalUniverseCluster[]) {
  if (clusters.length === 0) return new Map<string, StarMapPoint>();
  const ordered = [...clusters].sort((left, right) => (
    right.radius - left.radius || compareText(left.id, right.id)
  ));
  const radii = clusters.map((cluster) => cluster.radius).sort((left, right) => left - right);
  const medianRadius = radii[Math.floor(radii.length / 2)];
  const radialStep = Math.max(190, medianRadius * 1.42);
  const spatial = createUniverseSpatialIndex(Math.max(256, medianRadius * 1.4));
  const centers = new Map<string, StarMapPoint>();
  const universeSeed = `${ordered[0].id}:${ordered.at(-1)?.id ?? ordered[0].id}:${ordered.length}`;
  const orientation = hashRange(`${universeSeed}:orientation`, 0, FULL_TURN);
  const cosOrientation = Math.cos(orientation * 0.17);
  const sinOrientation = Math.sin(orientation * 0.17);
  const clusterGap = clusters.length > 180 ? 24 : clusters.length > 60 ? 30 : 38;

  const warpedCandidate = (cluster: LocalUniverseCluster, slot: number) => {
    const turbulence = Math.sin(slot * 1.31 + orientation) * 0.31 +
      Math.sin(slot * 0.37 - orientation * 0.7) * 0.2;
    const angle = orientation + slot * GOLDEN_ANGLE + turbulence +
      hashRange(`${cluster.id}:field-angle`, -0.22, 0.22);
    const distance = radialStep * Math.pow(slot, 0.56) *
      hashRange(`${cluster.id}:field-distance`, 0.84, 1.17);
    const localX = Math.cos(angle) * distance * 1.08;
    const localY = Math.sin(angle) * distance * 0.9;
    const flowX = Math.sin(angle * 2.13 + distance * 0.0017) * radialStep * 0.22;
    const flowY = Math.cos(angle * 1.71 - distance * 0.0013) * radialStep * 0.18;
    return {
      x: (localX + flowX) * cosOrientation - (localY + flowY) * sinOrientation,
      y: (localX + flowX) * sinOrientation + (localY + flowY) * cosOrientation,
    };
  };

  ordered.forEach((cluster, index) => {
    if (index === 0) {
      const center = { x: 0, y: 0 };
      centers.set(cluster.id, center);
      insertUniverseCircle(spatial, { id: cluster.id, ...center, radius: cluster.radius });
      return;
    }

    const desired = warpedCandidate(cluster, index);
    let center: StarMapPoint | null = null;
    if (universeCircleFits(spatial, desired, cluster.radius, clusterGap)) center = desired;

    const localPhase = hashRange(`${cluster.id}:local-search`, 0, FULL_TURN);
    for (let attempt = 1; !center && attempt <= 128; attempt += 1) {
      const wave = Math.sin(attempt * 0.83 + localPhase);
      const angle = localPhase + attempt * GOLDEN_ANGLE + wave * 0.13;
      const distance = Math.max(28, cluster.radius * 0.13) * Math.sqrt(attempt) *
        (1 + wave * 0.06);
      const candidate = {
        x: desired.x + Math.cos(angle) * distance * 1.05,
        y: desired.y + Math.sin(angle) * distance * 0.95,
      };
      if (universeCircleFits(spatial, candidate, cluster.radius, clusterGap)) center = candidate;
    }

    if (!center) {
      // Resume the warped low-discrepancy field farther out. This keeps dense
      // universes collision-free without snapping overflow galaxies to rows,
      // rings or four repeated arms.
      for (let attempt = 1; attempt <= 640; attempt += 1) {
        const candidate = warpedCandidate(cluster, ordered.length + index + attempt);
        if (!universeCircleFits(spatial, candidate, cluster.radius, clusterGap)) continue;
        center = candidate;
        break;
      }
    }
    if (!center) {
      const angle = orientation + hashRange(`${cluster.id}:overflow`, 0, FULL_TURN);
      const distance = radialStep * (ordered.length + index + 1);
      center = { x: Math.cos(angle) * distance, y: Math.sin(angle) * distance };
    }
    const roundedCenter = { x: rounded(center.x), y: rounded(center.y) };
    centers.set(cluster.id, roundedCenter);
    insertUniverseCircle(spatial, {
      id: cluster.id,
      ...roundedCenter,
      radius: cluster.radius,
    });
  });

  return centers;
}

/**
 * Organic, unbounded universe layout for the full raw graph.
 *
 * Weakly-connected knowledge systems become galaxies. The largest system forms
 * the visual core while the rest occupy a domain-warped low-discrepancy field,
 * avoiding rows, rings and repeated spiral arms. Inside each galaxy, semantic
 * ancestry grows as curved branches; high-fanout siblings breathe across
 * irregular orbits and cross-linked nodes bend toward secondary provenance.
 * No random state, input order, DOM, fixed viewport or active filter
 * participates in the result.
 */
export function createUniverseLayout(graph: UnderstandingGraph): UniverseLayout {
  const indexed = indexGraph(graph);
  if (indexed.graph.nodes.length === 0) {
    return {
      positions: {},
      bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 },
      clusterCenters: {},
    };
  }

  const components = weaklyConnectedComponents(indexed);
  const clusters = components.map((nodeIds) => layoutLocalUniverseCluster(indexed, nodeIds));
  const centers = placeUniverseClusters(clusters);
  const positions: Record<string, StarMapPoint> = {};
  const clusterCenters: Record<string, StarMapPoint> = {};
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const cluster of clusters) {
    const center = centers.get(cluster.id)!;
    clusterCenters[cluster.id] = center;
    for (const [nodeId, local] of cluster.positions) {
      const node = indexed.nodeById.get(nodeId)!;
      const point = {
        x: rounded(center.x + local.x),
        y: rounded(center.y + local.y),
      };
      positions[nodeId] = point;
      const radius = STAR_MAP_NODE_RADIUS[node.type];
      minX = Math.min(minX, point.x - radius);
      minY = Math.min(minY, point.y - radius);
      maxX = Math.max(maxX, point.x + radius);
      maxY = Math.max(maxY, point.y + radius);
    }
  }

  return {
    positions,
    bounds: {
      minX: rounded(minX),
      minY: rounded(minY),
      maxX: rounded(maxX),
      maxY: rounded(maxY),
      width: rounded(maxX - minX),
      height: rounded(maxY - minY),
    },
    clusterCenters,
  };
}
