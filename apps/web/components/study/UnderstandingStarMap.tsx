"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";

const VIEWBOX_WIDTH = 1600;
const VIEWBOX_HEIGHT = 960;
const MIN_ZOOM = 0.55;
const MAX_ZOOM = 2.4;
const ZOOM_STEP = 1.2;
const EMPTY_IDS: readonly string[] = [];

export type StarMapNodeType = "source" | "note" | "card" | "key_point";
export type StarMapEdgeType = "derived_from" | "generated_from" | "contains";

/**
 * The component intentionally depends on only the graph DTO fields it renders.
 * Full API nodes can be passed directly because their remaining fields are additive.
 */
export interface StarMapNode {
  id: string;
  type: StarMapNodeType;
  label: string;
  entityId?: string;
  description?: string | null;
  state?: string | null;
  href?: string | null;
  parentId?: string | null;
  evidenceCoverage?: number | null;
  hardEvidenceCount?: number;
  softEvidenceCount?: number;
  misunderstandingCount?: number;
  lastValidatedAt?: string | null;
  nextReviewAt?: string | null;
  metadata?: Record<string, unknown>;
}

export interface StarMapEdge {
  id: string;
  from: string;
  to: string;
  type: StarMapEdgeType;
  strength: number;
}

export interface StarMapPoint {
  x: number;
  y: number;
}

export type StarMapLayout = Readonly<Record<string, Readonly<StarMapPoint>>>;

export interface UnderstandingStarMapProps {
  nodes: readonly StarMapNode[];
  edges: readonly StarMapEdge[];
  layout: StarMapLayout;
  selectedId?: string | null;
  highlightedNodeIds?: readonly string[];
  highlightedEdgeIds?: readonly string[];
  onSelect: (id: string) => void;
  className?: string;
  ariaLabel?: string;
  title?: string;
  description?: string;
}

interface ViewportState {
  x: number;
  y: number;
  zoom: number;
}

interface DragState {
  pointerId: number;
  last: StarMapPoint;
}

interface PositionedEdge {
  edge: StarMapEdge;
  start: StarMapPoint;
  end: StarMapPoint;
}

const NODE_TYPE_LABEL: Record<StarMapNodeType, string> = {
  source: "来源资料",
  note: "笔记",
  card: "学习卡",
  key_point: "关键点",
};

const EDGE_TYPE_LABEL: Record<StarMapEdgeType, string> = {
  derived_from: "提炼自",
  generated_from: "生成自",
  contains: "包含",
};

const NODE_RADIUS: Record<StarMapNodeType, number> = {
  source: 53,
  note: 51,
  card: 59,
  key_point: 35,
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function normalizeCoverage(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return null;
  return clamp(value, 0, 1);
}

function normalizeStrength(value: number) {
  if (!Number.isFinite(value)) return 0.5;
  return clamp(value, 0, 1);
}

function safeToken(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function splitLabel(label: string, maxUnits = 13, maxLines = 2) {
  const lines: string[] = [];
  let line = "";
  let units = 0;
  const glyphs = Array.from(label.trim());

  for (const glyph of glyphs) {
    const width = /[\u0000-\u00ff]/.test(glyph) ? 0.58 : 1;
    if (line && units + width > maxUnits) {
      lines.push(line.trim());
      line = "";
      units = 0;
      if (lines.length === maxLines) break;
    }
    line += glyph;
    units += width;
  }

  if (line && lines.length < maxLines) lines.push(line.trim());
  if (lines.length === 0) lines.push("未命名对象");

  const displayedGlyphCount = Array.from(lines.join("")).length;
  if (displayedGlyphCount < glyphs.length) {
    lines[lines.length - 1] = `${lines[lines.length - 1].replace(/[\s…]+$/u, "")}…`;
  }
  return lines;
}

function edgeEndpoints(
  from: StarMapPoint,
  to: StarMapPoint,
  fromType: StarMapNodeType,
  toType: StarMapNodeType,
) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  if (distance === 0) return { start: from, end: to };
  const ux = dx / distance;
  const uy = dy / distance;
  return {
    start: {
      x: from.x + ux * NODE_RADIUS[fromType],
      y: from.y + uy * NODE_RADIUS[fromType],
    },
    end: {
      x: to.x - ux * (NODE_RADIUS[toType] + 6),
      y: to.y - uy * (NODE_RADIUS[toType] + 6),
    },
  };
}

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return reduced;
}

export function UnderstandingStarMap({
  nodes,
  edges,
  layout,
  selectedId = null,
  highlightedNodeIds = EMPTY_IDS,
  highlightedEdgeIds = EMPTY_IDS,
  onSelect,
  className = "",
  ariaLabel = "理解星图",
  title = "理解星图",
  description = "显示来源资料、笔记、学习卡与关键点之间的真实关系。可拖动空白区域平移，滚轮缩放，使用键盘选择节点。",
}: UnderstandingStarMapProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const [viewport, setViewport] = useState<ViewportState>({ x: 0, y: 0, zoom: 1 });
  const [isDragging, setIsDragging] = useState(false);
  const reducedMotion = usePrefersReducedMotion();
  const rawId = useId();
  const idPrefix = useMemo(() => `star-map-${rawId.replace(/:/g, "")}`, [rawId]);
  const titleId = `${idPrefix}-title`;
  const descriptionId = `${idPrefix}-description`;

  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const highlightedNodeIdSet = useMemo(() => new Set(highlightedNodeIds), [highlightedNodeIds]);
  const highlightedEdgeIdSet = useMemo(() => new Set(highlightedEdgeIds), [highlightedEdgeIds]);
  const hasHighlight = highlightedNodeIds.length > 0 || highlightedEdgeIds.length > 0;
  const visibleNodes = useMemo(
    () => nodes.filter((node) => {
      const point = layout[node.id];
      return Boolean(point && Number.isFinite(point.x) && Number.isFinite(point.y));
    }),
    [layout, nodes],
  );

  const positionedEdges = useMemo<PositionedEdge[]>(() => {
    return edges.flatMap((edge) => {
      const fromNode = nodeById.get(edge.from);
      const toNode = nodeById.get(edge.to);
      const from = layout[edge.from];
      const to = layout[edge.to];
      if (!fromNode || !toNode || !from || !to) return [];
      const { start, end } = edgeEndpoints(from, to, fromNode.type, toNode.type);
      return [{ edge, start, end }];
    });
  }, [edges, layout, nodeById]);

  const toViewBoxPoint = useCallback((clientX: number, clientY: number): StarMapPoint | null => {
    const svg = svgRef.current;
    if (!svg) return null;
    const matrix = svg.getScreenCTM();
    if (!matrix) return null;
    const point = new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse());
    return { x: point.x, y: point.y };
  }, []);

  const resetViewport = useCallback(() => {
    setViewport({ x: 0, y: 0, zoom: 1 });
  }, []);

  const zoomAt = useCallback((nextZoom: number, anchor?: StarMapPoint) => {
    setViewport((current) => {
      const zoom = clamp(nextZoom, MIN_ZOOM, MAX_ZOOM);
      const point = anchor ?? { x: VIEWBOX_WIDTH / 2, y: VIEWBOX_HEIGHT / 2 };
      const worldX = (point.x - current.x) / current.zoom;
      const worldY = (point.y - current.y) / current.zoom;
      return {
        zoom,
        x: point.x - worldX * zoom,
        y: point.y - worldY * zoom,
      };
    });
  }, []);

  const handleWheel = useCallback((event: ReactWheelEvent<SVGSVGElement>) => {
    event.preventDefault();
    const anchor = toViewBoxPoint(event.clientX, event.clientY);
    if (!anchor) return;
    const factor = Math.exp(-event.deltaY * 0.0015);
    setViewport((current) => {
      const zoom = clamp(current.zoom * factor, MIN_ZOOM, MAX_ZOOM);
      const worldX = (anchor.x - current.x) / current.zoom;
      const worldY = (anchor.y - current.y) / current.zoom;
      return {
        zoom,
        x: anchor.x - worldX * zoom,
        y: anchor.y - worldY * zoom,
      };
    });
  }, [toViewBoxPoint]);

  const handleBackgroundPointerDown = useCallback((event: ReactPointerEvent<SVGRectElement>) => {
    if (event.button !== 0) return;
    const point = toViewBoxPoint(event.clientX, event.clientY);
    if (!point) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, last: point };
    setIsDragging(true);
  }, [toViewBoxPoint]);

  const handleBackgroundPointerMove = useCallback((event: ReactPointerEvent<SVGRectElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const next = toViewBoxPoint(event.clientX, event.clientY);
    if (!next) return;
    const dx = next.x - drag.last.x;
    const dy = next.y - drag.last.y;
    drag.last = next;
    setViewport((current) => ({ ...current, x: current.x + dx, y: current.y + dy }));
  }, [toViewBoxPoint]);

  const finishDragging = useCallback((event: ReactPointerEvent<SVGRectElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragRef.current = null;
    setIsDragging(false);
  }, []);

  const handleMapKeyDown = useCallback((event: ReactKeyboardEvent<SVGSVGElement>) => {
    if (event.target !== event.currentTarget) return;
    const panStep = event.shiftKey ? 120 : 52;
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      zoomAt(viewport.zoom * ZOOM_STEP);
    } else if (event.key === "-" || event.key === "_") {
      event.preventDefault();
      zoomAt(viewport.zoom / ZOOM_STEP);
    } else if (event.key === "Home" || event.key === "0") {
      event.preventDefault();
      resetViewport();
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      setViewport((current) => ({ ...current, x: current.x + panStep }));
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      setViewport((current) => ({ ...current, x: current.x - panStep }));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setViewport((current) => ({ ...current, y: current.y + panStep }));
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setViewport((current) => ({ ...current, y: current.y - panStep }));
    }
  }, [resetViewport, viewport.zoom, zoomAt]);

  const mapClassName = [
    "star-map",
    className,
    isDragging ? "is-dragging" : "",
    reducedMotion ? "is-reduced-motion" : "",
  ].filter(Boolean).join(" ");

  return (
    <section
      className={mapClassName}
      aria-label={ariaLabel}
      data-node-count={visibleNodes.length}
      data-edge-count={positionedEdges.length}
      data-density={visibleNodes.length > 72 ? "packed" : visibleNodes.length > 36 ? "dense" : "comfortable"}
      data-reduced-motion={reducedMotion ? "true" : "false"}
    >
      <div className="star-map-controls" role="group" aria-label="星图视图控制">
        <button
          type="button"
          className="star-map-control star-map-control--zoom-in"
          onClick={() => zoomAt(viewport.zoom * ZOOM_STEP)}
          disabled={viewport.zoom >= MAX_ZOOM}
          aria-label="放大星图"
          title="放大"
        >
          <span aria-hidden="true">＋</span>
        </button>
        <output className="star-map-zoom-readout" aria-label="当前缩放比例" aria-live="polite">
          {Math.round(viewport.zoom * 100)}%
        </output>
        <button
          type="button"
          className="star-map-control star-map-control--zoom-out"
          onClick={() => zoomAt(viewport.zoom / ZOOM_STEP)}
          disabled={viewport.zoom <= MIN_ZOOM}
          aria-label="缩小星图"
          title="缩小"
        >
          <span aria-hidden="true">−</span>
        </button>
        <button
          type="button"
          className="star-map-control star-map-control--reset"
          onClick={resetViewport}
          disabled={viewport.zoom === 1 && viewport.x === 0 && viewport.y === 0}
          aria-label="将星图归位"
          title="归位"
        >
          <span aria-hidden="true">↺</span>
        </button>
      </div>

      <svg
        ref={svgRef}
        className="star-map-canvas"
        viewBox={`0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}`}
        preserveAspectRatio="xMidYMid meet"
        role="group"
        tabIndex={0}
        aria-labelledby={`${titleId} ${descriptionId}`}
        onWheel={handleWheel}
        onKeyDown={handleMapKeyDown}
        style={{ touchAction: "none" }}
      >
        <title id={titleId}>{title}</title>
        <desc id={descriptionId}>
          {description} 当前显示 {visibleNodes.length} 个节点、{positionedEdges.length} 条关系。
        </desc>

        <defs>
          {(["derived_from", "generated_from", "contains"] as const).map((type) => (
            <marker
              key={type}
              id={`${idPrefix}-arrow-${type}`}
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path
                d="M 0 0 L 10 5 L 0 10 z"
                className={`star-map-edge-arrow star-map-edge-arrow--${type}`}
              />
            </marker>
          ))}
        </defs>

        <rect
          className="star-map-background"
          x="0"
          y="0"
          width={VIEWBOX_WIDTH}
          height={VIEWBOX_HEIGHT}
          onPointerDown={handleBackgroundPointerDown}
          onPointerMove={handleBackgroundPointerMove}
          onPointerUp={finishDragging}
          onPointerCancel={finishDragging}
          onLostPointerCapture={() => {
            dragRef.current = null;
            setIsDragging(false);
          }}
        />

        <g
          className="star-map-viewport"
          transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.zoom})`}
        >
          <g className="star-map-edges" aria-label="对象关系">
            {positionedEdges.map(({ edge, start, end }) => {
              const strength = normalizeStrength(edge.strength);
              const isHighlighted = hasHighlight && highlightedEdgeIdSet.has(edge.id);
              const isDimmed = hasHighlight && !isHighlighted;
              return (
                <line
                  key={edge.id}
                  className={`star-map-edge star-map-edge--${edge.type}${isHighlighted ? " is-highlighted" : ""}${isDimmed ? " is-dimmed" : ""}`}
                  x1={start.x}
                  y1={start.y}
                  x2={end.x}
                  y2={end.y}
                  markerEnd={`url(#${idPrefix}-arrow-${edge.type})`}
                  data-edge-id={edge.id}
                  data-edge-type={edge.type}
                  style={{
                    "--star-map-edge-strength": strength,
                    opacity: 0.38 + strength * 0.54,
                    strokeWidth: 1.25 + strength * 1.75,
                  } as CSSProperties}
                >
                  <title>{EDGE_TYPE_LABEL[edge.type]}</title>
                </line>
              );
            })}
          </g>

          <g className="star-map-nodes" aria-label="理解对象">
            {visibleNodes.map((node) => {
              const point = layout[node.id];
              const coverage = normalizeCoverage(node.evidenceCoverage);
              const coveragePercent = coverage == null ? null : Math.round(coverage * 100);
              const isSelected = selectedId === node.id;
              const isHighlighted = hasHighlight && (isSelected || highlightedNodeIdSet.has(node.id));
              const isDimmed = hasHighlight && !isHighlighted;
              const typeClass = node.type === "key_point" ? "key-point" : node.type;
              const stateClass = node.state ? ` star-map-node--state-${safeToken(node.state)}` : "";
              const nodeClassName = `star-map-node star-map-node--${typeClass}${stateClass}${isSelected ? " is-selected" : ""}${isHighlighted ? " is-highlighted" : ""}${isDimmed ? " is-dimmed" : ""}`;
              const labelLines = splitLabel(node.label);
              const ariaParts = [NODE_TYPE_LABEL[node.type], node.label];
              if (coveragePercent != null && node.type === "card") {
                ariaParts.push(`证据覆盖率 ${coveragePercent}%`);
              }
              if (node.misunderstandingCount) ariaParts.push(`误解 ${node.misunderstandingCount} 次`);

              return (
                <g
                  key={node.id}
                  className={nodeClassName}
                  transform={`translate(${point.x} ${point.y})`}
                  role="button"
                  tabIndex={0}
                  aria-label={ariaParts.join("，")}
                  aria-pressed={isSelected}
                  data-node-id={node.id}
                  data-node-type={node.type}
                  data-state={node.state ?? undefined}
                  onClick={() => onSelect(node.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      event.stopPropagation();
                      onSelect(node.id);
                    }
                  }}
                >
                  <title>{ariaParts.join(" · ")}</title>
                  <NodeShape node={node} coverage={coverage} />
                  <text
                    className="star-map-node-label"
                    textAnchor="middle"
                    y={node.type === "card" ? 78 : node.type === "key_point" ? 48 : 62}
                    aria-hidden="true"
                  >
                    {labelLines.map((line, index) => (
                      <tspan key={`${line}-${index}`} x="0" dy={index === 0 ? 0 : 19}>
                        {line}
                      </tspan>
                    ))}
                  </text>
                  {node.type === "card" && coveragePercent != null && (
                    <text className="star-map-node-coverage-label" textAnchor="middle" y="35" aria-hidden="true">
                      {coveragePercent}%
                    </text>
                  )}
                </g>
              );
            })}
          </g>
        </g>
      </svg>
    </section>
  );
}

function NodeShape({ node, coverage }: { node: StarMapNode; coverage: number | null }) {
  if (node.type === "card") {
    return (
      <g className="star-map-node-shape star-map-node-shape--card" aria-hidden="true">
        <circle className="star-map-card-halo-track" r="57" />
        <circle
          className={`star-map-card-halo-value${coverage == null ? " is-unknown" : ""}`}
          r="57"
          pathLength="100"
          strokeDasharray={`${(coverage ?? 0) * 100} ${100 - (coverage ?? 0) * 100}`}
          transform="rotate(-90)"
        />
        <circle className="star-map-card-core" r="45" />
        <path
          className="star-map-card-star"
          d="M0 -22 L5.2 -7.2 L21 -6.8 L8.3 2.6 L12.9 18 L0 9 L-12.9 18 L-8.3 2.6 L-21 -6.8 L-5.2 -7.2 Z"
        />
      </g>
    );
  }

  if (node.type === "source") {
    return (
      <g className="star-map-node-shape star-map-node-shape--source" aria-hidden="true">
        <path className="star-map-source-orbit" d="M-50 0 C-35 -28 35 -28 50 0 C35 28 -35 28 -50 0 Z" />
        <path className="star-map-source-core" d="M0 -34 L38 -17 L38 17 L0 34 L-38 17 L-38 -17 Z" />
        <circle className="star-map-source-dot" r="8" />
      </g>
    );
  }

  if (node.type === "note") {
    return (
      <g className="star-map-node-shape star-map-node-shape--note" aria-hidden="true">
        <path className="star-map-note-paper" d="M-34 -40 H16 L36 -20 V40 H-34 Z" />
        <path className="star-map-note-fold" d="M16 -40 V-20 H36" />
        <path className="star-map-note-lines" d="M-19 -10 H19 M-19 4 H19 M-19 18 H10" />
      </g>
    );
  }

  return (
    <g className="star-map-node-shape star-map-node-shape--key-point" aria-hidden="true">
      <path className="star-map-key-point-diamond" d="M0 -31 L31 0 L0 31 L-31 0 Z" />
      <circle className="star-map-key-point-core" r="7" />
    </g>
  );
}
