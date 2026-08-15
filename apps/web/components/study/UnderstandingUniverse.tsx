"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";

import type { GraphEdge, GraphNode } from "@/lib/understanding-graph";

const MIN_ZOOM = 0.12;
const MAX_ZOOM = 4.6;
const ZOOM_FACTOR = 1.24;
const ACTIVE_FRAME_INTERVAL = 1000 / 30;
const LARGE_ACTIVE_FRAME_INTERVAL = 1000 / 20;
const VIEWPORT_RESPONSE_MS = 76;
const FOCUS_RESPONSE_MS = 48;
const DOUBLE_CLICK_RESPONSE_MS = 34;
const DPR_LIMIT = 2;
const FIT_PADDING = 96;
const HIT_CELL_SIZE = 72;
const LABEL_CELL_WIDTH = 96;
const LABEL_CELL_HEIGHT = 32;
const OFFSET_STORAGE_KEY = "understanding-universe:node-offsets:v1";
const OFFSET_EPSILON = 0.05;

const EMPTY_IDS: string[] = [];

export interface UniversePoint {
  x: number;
  y: number;
}

export type UniversePositions = Record<string, UniversePoint>;

export interface UnderstandingUniverseProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  positions: UniversePositions;
  selectedId: string | null;
  highlightedNodeIds?: Set<string> | string[];
  highlightedEdgeIds?: Set<string> | string[];
  onSelect: (id: string | null) => void;
  className?: string;
  title?: string;
  /** 挂载时的初始视口（设备本地快照恢复；缺省自动 fit）。 */
  initialViewport?: { zoom: number; offsetX: number; offsetY: number } | null;
  /** 视口变化上报（节流；用于本地视口快照，文档 16 §15.6）。 */
  onViewportChange?: (viewport: { zoom: number; offsetX: number; offsetY: number }) => void;
  /** F18（round4）：offset 本地裁剪 key 的可选命名空间（调用方按工作区传入），
   * 避免不同工作区/账户之间串态（local pruning 有界但 key 无维度）。 */
  storageNamespace?: string;
}

export interface UnderstandingUniverseHandle {
  zoomIn(): void;
  zoomOut(): void;
  fit(): void;
  reset(): void;
  focusNode(nodeId: string): void;
}

interface Viewport {
  offsetX: number;
  offsetY: number;
  zoom: number;
}

interface CanvasSize {
  width: number;
  height: number;
  dpr: number;
}

interface PointerDrag {
  id: number;
  nodeId: string | null;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  lastTime: number;
  velocityX: number;
  velocityY: number;
  moved: boolean;
}

interface PinchGesture {
  distance: number;
  center: UniversePoint;
}

interface ScreenNode {
  node: GraphNode;
  x: number;
  y: number;
  radius: number;
}

interface ScreenSpatialIndex {
  viewport: Viewport;
  nodesReference: GraphNode[];
  positionsReference: UniversePositions;
  customRevision: number;
  buckets: Map<string, ScreenNode[]>;
}

interface PanInertia {
  velocityX: number;
  velocityY: number;
  lastTime: number;
}

type RenderQuality = "overview" | "balanced" | "detail" | "interaction";

interface UniverseCluster {
  id: number;
  nodeIds: Set<string>;
  representativeId: string;
  center: UniversePoint;
  radiusX: number;
  radiusY: number;
  angle: number;
  seed: number;
}

interface LabelPlacement {
  nodeId: string;
  text: string;
  x: number;
  y: number;
  width: number;
  alpha: number;
  color: string;
  dynamic: boolean;
}

interface SceneCache {
  key: string;
  canvas: HTMLCanvasElement;
  screenNodes: Map<string, ScreenNode>;
  dynamicNodes: ScreenNode[];
  dynamicEdges: GraphEdge[];
  dynamicLabels: LabelPlacement[];
}

interface BackgroundCache {
  key: string;
  canvas: HTMLCanvasElement;
}

interface DustStar {
  x: number;
  y: number;
  size: number;
  alpha: number;
  phase: number;
  speed: number;
  layer: number;
}

interface Palette {
  spaceTop: string;
  spaceBottom: string;
  nebulaA: string;
  nebulaB: string;
  dust: string;
  text: string;
  muted: string;
  edge: string;
  edgeGlow: string;
  source: string;
  note: string;
  card: string;
  keyPoint: string;
  orbit: string;
  evidenceTrack: string;
  selected: string;
  labelBackdrop: string;
  states: Record<string, string>;
}

const TYPE_LABEL: Record<GraphNode["type"], string> = {
  source: "来源资料",
  note: "笔记",
  card: "学习卡",
  key_point: "关键点",
  evidence: "证据",
};

const STATE_LABEL: Record<string, string> = {
  misunderstood: "存在误区",
  due_review: "待复习",
  preliminary_understood: "初步理解",
  reviewed: "已复习",
  seen: "已接触",
  unseen: "未验证",
};

const BASE_RADIUS: Record<GraphNode["type"], number> = {
  source: 17,
  note: 15,
  card: 23,
  key_point: 8,
  evidence: 5,
};

const DEFAULT_PALETTE: Palette = {
  spaceTop: "#071020",
  spaceBottom: "#02050d",
  nebulaA: "rgba(47, 116, 177, 0.18)",
  nebulaB: "rgba(216, 143, 59, 0.12)",
  dust: "#dcecff",
  text: "#f5f1e8",
  muted: "rgba(222, 231, 240, 0.62)",
  edge: "rgba(155, 190, 218, 0.16)",
  edgeGlow: "#8ed8ff",
  source: "#efb95f",
  note: "#83c9dc",
  card: "#fff1b8",
  keyPoint: "#b7d9ff",
  orbit: "rgba(205, 224, 243, 0.28)",
  evidenceTrack: "rgba(225, 235, 245, 0.16)",
  selected: "#fff3a6",
  labelBackdrop: "#030812",
  states: {
    misunderstood: "#ff806d",
    due_review: "#ffb14c",
    preliminary_understood: "#6ed7d0",
    reviewed: "#68d49c",
    seen: "#9eaece",
    unseen: "#77859d",
  },
};

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function finitePoint(point: Readonly<UniversePoint> | undefined): point is Readonly<UniversePoint> {
  return Boolean(point && Number.isFinite(point.x) && Number.isFinite(point.y));
}

function hashNumber(value: number) {
  const sine = Math.sin(value * 12.9898 + 78.233) * 43758.5453;
  return sine - Math.floor(sine);
}

function hashString(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967295;
}

function cssValue(style: CSSStyleDeclaration, name: string, fallback: string) {
  return style.getPropertyValue(name).trim() || fallback;
}

function readPalette(element: HTMLElement): Palette {
  const style = getComputedStyle(element);
  return {
    spaceTop: cssValue(style, "--universe-space-top", DEFAULT_PALETTE.spaceTop),
    spaceBottom: cssValue(style, "--universe-space-bottom", DEFAULT_PALETTE.spaceBottom),
    nebulaA: cssValue(style, "--universe-nebula-a", DEFAULT_PALETTE.nebulaA),
    nebulaB: cssValue(style, "--universe-nebula-b", DEFAULT_PALETTE.nebulaB),
    dust: cssValue(style, "--universe-dust", DEFAULT_PALETTE.dust),
    text: cssValue(style, "--universe-label", DEFAULT_PALETTE.text),
    muted: cssValue(style, "--universe-label-muted", DEFAULT_PALETTE.muted),
    edge: cssValue(style, "--universe-edge", DEFAULT_PALETTE.edge),
    edgeGlow: cssValue(style, "--universe-edge-glow", DEFAULT_PALETTE.edgeGlow),
    source: cssValue(style, "--universe-source", DEFAULT_PALETTE.source),
    note: cssValue(style, "--universe-note", DEFAULT_PALETTE.note),
    card: cssValue(style, "--universe-card", DEFAULT_PALETTE.card),
    keyPoint: cssValue(style, "--universe-key-point", DEFAULT_PALETTE.keyPoint),
    orbit: cssValue(style, "--universe-orbit", DEFAULT_PALETTE.orbit),
    evidenceTrack: cssValue(style, "--universe-evidence-track", DEFAULT_PALETTE.evidenceTrack),
    selected: cssValue(style, "--universe-selected", DEFAULT_PALETTE.selected),
    labelBackdrop: cssValue(
      style,
      "--universe-label-backdrop",
      cssValue(style, "--universe-space-bottom", DEFAULT_PALETTE.labelBackdrop),
    ),
    states: {
      misunderstood: cssValue(
        style,
        "--universe-state-misunderstood",
        DEFAULT_PALETTE.states.misunderstood,
      ),
      due_review: cssValue(style, "--universe-state-due", DEFAULT_PALETTE.states.due_review),
      preliminary_understood: cssValue(
        style,
        "--universe-state-understood",
        DEFAULT_PALETTE.states.preliminary_understood,
      ),
      reviewed: cssValue(style, "--universe-state-reviewed", DEFAULT_PALETTE.states.reviewed),
      seen: cssValue(style, "--universe-state-seen", DEFAULT_PALETTE.states.seen),
      unseen: cssValue(style, "--universe-state-unseen", DEFAULT_PALETTE.states.unseen),
    },
  };
}

function makeDust(count: number): DustStar[] {
  return Array.from({ length: count }, (_, index) => ({
    x: hashNumber(index * 7 + 1),
    y: hashNumber(index * 7 + 2),
    size: 0.45 + hashNumber(index * 7 + 3) * 1.45,
    alpha: 0.16 + hashNumber(index * 7 + 4) * 0.68,
    phase: hashNumber(index * 7 + 5) * Math.PI * 2,
    speed: 0.35 + hashNumber(index * 7 + 6) * 0.75,
    layer: 0.015 + hashNumber(index * 7 + 7) * 0.035,
  }));
}

function typeColor(type: GraphNode["type"], palette: Palette) {
  if (type === "source") return palette.source;
  if (type === "note") return palette.note;
  if (type === "key_point") return palette.keyPoint;
  return palette.card;
}

function stateColor(node: GraphNode, palette: Palette) {
  return (node.state && palette.states[node.state]) || typeColor(node.type, palette);
}

function nodeRadius(node: GraphNode, zoom: number) {
  const scale = clamp(Math.pow(zoom, 0.72), 0.28, 1.45);
  return BASE_RADIUS[node.type] * scale;
}

function screenPoint(point: Readonly<UniversePoint>, viewport: Viewport) {
  return {
    x: point.x * viewport.zoom + viewport.offsetX,
    y: point.y * viewport.zoom + viewport.offsetY,
  };
}

function worldPoint(x: number, y: number, viewport: Viewport) {
  return {
    x: (x - viewport.offsetX) / viewport.zoom,
    y: (y - viewport.offsetY) / viewport.zoom,
  };
}

function readPinchGesture(points: Map<number, UniversePoint>): PinchGesture | null {
  const [first, second] = [...points.values()];
  if (!first || !second) return null;
  return {
    distance: Math.max(1, Math.hypot(second.x - first.x, second.y - first.y)),
    center: {
      x: (first.x + second.x) / 2,
      y: (first.y + second.y) / 2,
    },
  };
}

function fitViewport(
  nodes: GraphNode[],
  positions: UniversePositions,
  size: CanvasSize,
): Viewport {
  const points = nodes.map((node) => positions[node.id]).filter(finitePoint);
  if (points.length === 0 || size.width <= 0 || size.height <= 0) {
    return { offsetX: size.width / 2, offsetY: size.height / 2, zoom: 1 };
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }

  const availableWidth = Math.max(120, size.width - FIT_PADDING * 2);
  const availableHeight = Math.max(120, size.height - FIT_PADDING * 2);
  const graphWidth = Math.max(180, maxX - minX);
  const graphHeight = Math.max(180, maxY - minY);
  const zoom = clamp(Math.min(availableWidth / graphWidth, availableHeight / graphHeight), MIN_ZOOM, 1.5);
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;

  return {
    zoom,
    offsetX: size.width / 2 - centerX * zoom,
    offsetY: size.height / 2 - centerY * zoom,
  };
}

function truncateLabel(label: string, maxLength: number) {
  const glyphs = Array.from(label.trim() || "未命名对象");
  return glyphs.length <= maxLength ? glyphs.join("") : `${glyphs.slice(0, maxLength - 1).join("")}…`;
}

function canvasLayer(width: number, height: number, dpr: number) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(width * dpr));
  canvas.height = Math.max(1, Math.ceil(height * dpr));
  return canvas;
}

function paletteKey(palette: Palette) {
  return [
    palette.spaceTop,
    palette.spaceBottom,
    palette.nebulaA,
    palette.nebulaB,
    palette.dust,
    palette.text,
    palette.muted,
    palette.edge,
    palette.edgeGlow,
    palette.source,
    palette.note,
    palette.card,
    palette.keyPoint,
    palette.orbit,
    palette.evidenceTrack,
    palette.selected,
    palette.labelBackdrop,
    ...Object.values(palette.states),
  ].join("|");
}

function viewportMatches(left: Viewport, right: Viewport) {
  return (
    Math.abs(left.offsetX - right.offsetX) < 0.01 &&
    Math.abs(left.offsetY - right.offsetY) < 0.01 &&
    Math.abs(left.zoom - right.zoom) < 0.0001
  );
}

function renderQuality(zoom: number, visibleCount: number, interacting: boolean): RenderQuality {
  if (interacting) return "interaction";
  if (zoom < 0.3 || visibleCount > 950) return "overview";
  if (zoom < 0.72 || visibleCount > 420) return "balanced";
  return "detail";
}

function nodeIsVisibleAtLod(
  node: GraphNode,
  zoom: number,
  representativeIds: Set<string>,
  emphasized: boolean,
) {
  if (emphasized) return true;
  if (zoom < 0.135) return node.type === "card" || representativeIds.has(node.id);
  if (zoom < 0.34) return node.type !== "key_point" || hashString(node.id) <= 0.58;
  if (zoom < 0.52) return true;
  return true;
}

function labelGridKey(column: number, row: number) {
  return `${column}:${row}`;
}

function rectCells(left: number, top: number, width: number, height: number) {
  const startColumn = Math.floor(left / LABEL_CELL_WIDTH);
  const endColumn = Math.floor((left + width) / LABEL_CELL_WIDTH);
  const startRow = Math.floor(top / LABEL_CELL_HEIGHT);
  const endRow = Math.floor((top + height) / LABEL_CELL_HEIGHT);
  const cells: string[] = [];
  for (let column = startColumn; column <= endColumn; column += 1) {
    for (let row = startRow; row <= endRow; row += 1) cells.push(labelGridKey(column, row));
  }
  return cells;
}

function drawRoundedLabel(
  context: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  width: number,
  color: string,
  backdrop: string,
  alpha: number,
) {
  context.save();
  context.font = '500 12px "Noto Sans SC", "PingFang SC", sans-serif';
  context.textAlign = "center";
  context.textBaseline = "middle";
  const left = x - width / 2;
  const top = y - 10;
  context.globalAlpha = alpha * 0.82;
  context.fillStyle = backdrop;
  context.beginPath();
  context.roundRect(left, top, width, 20, 10);
  context.fill();
  context.globalAlpha = Math.min(1, alpha + 0.14);
  context.fillStyle = color;
  context.fillText(text, x, y + 0.5, width - 10);
  context.restore();
}

function drawPlanet(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  color: string,
  time: number,
  quality: RenderQuality,
  emphasized: boolean,
) {
  context.save();
  context.translate(x, y);
  if ((quality === "interaction" || quality === "overview") && !emphasized) {
    context.globalAlpha = emphasized ? 1 : 0.82;
    context.fillStyle = color;
    context.beginPath();
    context.arc(0, 0, Math.max(2, radius * 0.7), 0, Math.PI * 2);
    context.fill();
    context.globalAlpha = emphasized ? 0.58 : 0.28;
    context.strokeStyle = color;
    context.lineWidth = 0.8;
    context.beginPath();
    context.ellipse(0, 0, radius * 1.42, radius * 0.44, -0.24, 0, Math.PI * 2);
    context.stroke();
    context.restore();
    return;
  }
  context.rotate(-0.24);
  context.strokeStyle = color;
  context.globalAlpha = 0.52;
  context.lineWidth = 1.2;
  context.beginPath();
  context.ellipse(0, 0, radius * 1.55, radius * 0.48, 0, 0, Math.PI * 2);
  context.stroke();
  context.rotate(0.24);
  const gradient = context.createRadialGradient(-radius * 0.32, -radius * 0.36, 1, 0, 0, radius);
  gradient.addColorStop(0, "rgba(255,255,255,0.94)");
  gradient.addColorStop(0.22, color);
  gradient.addColorStop(1, "rgba(5,10,22,0.72)");
  context.globalAlpha = 1;
  context.fillStyle = gradient;
  context.shadowColor = color;
  context.shadowBlur = emphasized ? 13 + Math.sin(time * 0.001) * 1.25 : 7;
  context.beginPath();
  context.arc(0, 0, radius * 0.72, 0, Math.PI * 2);
  context.fill();
  context.restore();
}

function drawNoteAnchor(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  color: string,
  quality: RenderQuality,
  emphasized: boolean,
) {
  const width = radius * 1.16;
  const height = radius * 1.42;
  context.save();
  context.translate(x, y);
  context.strokeStyle = color;
  context.fillStyle = "rgba(8,18,34,0.84)";
  context.lineWidth = quality === "detail" ? 1.35 : 1;
  if (quality === "detail" || emphasized) {
    context.shadowColor = color;
    context.shadowBlur = emphasized ? 12 : 6;
  }
  context.beginPath();
  context.moveTo(-width / 2, -height / 2);
  context.lineTo(width * 0.18, -height / 2);
  context.lineTo(width / 2, -height * 0.18);
  context.lineTo(width / 2, height / 2);
  context.lineTo(-width / 2, height / 2);
  context.closePath();
  context.fill();
  context.stroke();
  if ((quality === "interaction" || quality === "overview") && !emphasized) {
    context.restore();
    return;
  }
  context.globalAlpha = 0.72;
  context.beginPath();
  context.moveTo(-width * 0.28, -height * 0.05);
  context.lineTo(width * 0.28, -height * 0.05);
  context.moveTo(-width * 0.28, height * 0.18);
  context.lineTo(width * 0.16, height * 0.18);
  context.stroke();
  context.restore();
}

function drawMainStar(
  context: CanvasRenderingContext2D,
  node: GraphNode,
  x: number,
  y: number,
  radius: number,
  color: string,
  palette: Palette,
  time: number,
  emphasized: boolean,
  quality: RenderQuality,
  seed: number,
) {
  const pulse = emphasized ? 1 + Math.sin(time * 0.0032 + seed * 4) * 0.055 : 1;
  const auraRadius = radius * (emphasized ? 3.05 : 2.45) * pulse;
  context.save();
  if ((quality !== "interaction" || emphasized) && (quality !== "overview" || emphasized)) {
    const aura = context.createRadialGradient(x, y, 1, x, y, auraRadius);
    aura.addColorStop(0, color);
    aura.addColorStop(0.16, color);
    aura.addColorStop(1, "rgba(0,0,0,0)");
    context.globalAlpha = emphasized ? 0.27 : quality === "detail" ? 0.17 : 0.11;
    context.fillStyle = aura;
    context.beginPath();
    context.arc(x, y, auraRadius, 0, Math.PI * 2);
    context.fill();
  }

  const coverage = node.evidenceCoverage == null ? null : clamp(node.evidenceCoverage, 0, 1);
  const haloRadius = radius * 1.38;
  context.globalAlpha = 1;
  context.lineCap = "round";
  context.lineWidth = emphasized ? 1.9 : quality === "detail" ? 1.45 : 1.05;
  context.strokeStyle = palette.evidenceTrack;
  context.beginPath();
  context.arc(x, y, haloRadius, 0, Math.PI * 2);
  context.stroke();
  if (coverage != null && coverage > 0) {
    context.strokeStyle = color;
    context.shadowColor = color;
    context.shadowBlur = emphasized ? 10 : quality === "detail" ? 5 : 0;
    context.beginPath();
    context.arc(x, y, haloRadius, -Math.PI / 2, -Math.PI / 2 + coverage * Math.PI * 2);
    context.stroke();
  }

  const core = radius * 0.46;
  context.translate(x, y);
  context.rotate((emphasized ? time * 0.000055 : 0) + seed * Math.PI);
  context.fillStyle = palette.card;
  context.shadowColor = color;
  context.shadowBlur = emphasized ? 20 : quality === "detail" ? 11 : quality === "balanced" ? 6 : 0;
  context.beginPath();
  context.moveTo(0, -core * 1.7);
  context.quadraticCurveTo(core * 0.2, -core * 0.2, core * 1.7, 0);
  context.quadraticCurveTo(core * 0.2, core * 0.2, 0, core * 1.7);
  context.quadraticCurveTo(-core * 0.2, core * 0.2, -core * 1.7, 0);
  context.quadraticCurveTo(-core * 0.2, -core * 0.2, 0, -core * 1.7);
  context.fill();
  context.fillStyle = "rgba(255,255,255,0.96)";
  context.beginPath();
  context.arc(0, 0, core * 0.34, 0, Math.PI * 2);
  context.fill();
  context.restore();
}

function drawSatellite(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  color: string,
  time: number,
  seed: number,
  quality: RenderQuality,
  emphasized: boolean,
) {
  context.save();
  if ((quality !== "interaction" || emphasized) && (quality !== "overview" || emphasized)) {
    context.strokeStyle = color;
    context.globalAlpha = emphasized ? 0.38 : 0.22;
    context.lineWidth = 0.8;
    context.beginPath();
    context.arc(x, y, radius * 1.75, 0, Math.PI * 2);
    context.stroke();
  }
  context.globalAlpha = 1;
  context.fillStyle = color;
  if (quality === "detail" || emphasized) {
    context.shadowColor = color;
    context.shadowBlur = emphasized ? 8 : 4;
  }
  context.beginPath();
  context.arc(
    x,
    y,
    radius * (0.58 + (emphasized ? Math.sin(time * 0.0017 + seed * 7) * 0.035 : 0)),
    0,
    Math.PI * 2,
  );
  context.fill();
  if (quality === "detail" || emphasized) {
    context.fillStyle = "rgba(255,255,255,0.92)";
    context.beginPath();
    context.arc(x - radius * 0.17, y - radius * 0.17, Math.max(1, radius * 0.16), 0, Math.PI * 2);
    context.fill();
  }
  context.restore();
}

function drawSelectionOrbit(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  color: string,
  time: number,
) {
  const pulse = 1 + Math.sin(time * 0.0042) * 0.055;
  const orbitRadius = radius * 1.82 * pulse;
  context.save();
  context.translate(x, y);
  context.rotate(time * 0.0004);
  context.strokeStyle = color;
  context.globalAlpha = 0.7;
  context.lineWidth = 1.1;
  context.setLineDash([2, 6]);
  context.beginPath();
  context.arc(0, 0, orbitRadius, 0, Math.PI * 2);
  context.stroke();
  context.setLineDash([]);
  context.fillStyle = color;
  context.shadowColor = color;
  context.shadowBlur = 8;
  context.beginPath();
  context.arc(orbitRadius, 0, 2.2, 0, Math.PI * 2);
  context.fill();
  context.restore();
}

function edgeControlPoint(
  from: UniversePoint,
  to: UniversePoint,
  edge: GraphEdge,
): UniversePoint {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.max(1, Math.hypot(dx, dy));
  const bend = (hashString(edge.id || `${edge.from}:${edge.to}`) - 0.5) * Math.min(58, length * 0.16);
  return {
    x: (from.x + to.x) / 2 - (dy / length) * bend,
    y: (from.y + to.y) / 2 + (dx / length) * bend,
  };
}

function drawClusterEnvelope(
  context: CanvasRenderingContext2D,
  cluster: UniverseCluster,
  viewport: Viewport,
  palette: Palette,
  emphasized: boolean,
  quality: RenderQuality,
) {
  if (cluster.nodeIds.size < 3 || (quality === "interaction" && !emphasized)) return;
  const center = screenPoint(cluster.center, viewport);
  const radiusX = clamp(cluster.radiusX * viewport.zoom, 54, 720);
  const radiusY = clamp(cluster.radiusY * viewport.zoom, 42, 560);
  const glowRadius = Math.max(radiusX, radiusY);
  const color = cluster.id % 2 === 0 ? palette.nebulaA : palette.nebulaB;
  context.save();
  context.translate(center.x, center.y);
  context.rotate(cluster.angle);
  const glow = context.createRadialGradient(0, 0, 0, 0, 0, glowRadius);
  glow.addColorStop(0, color);
  glow.addColorStop(0.48, color);
  glow.addColorStop(1, "rgba(0,0,0,0)");
  context.globalAlpha = emphasized ? 0.42 : quality === "overview" ? 0.22 : 0.14;
  context.fillStyle = glow;
  context.scale(1, radiusY / Math.max(1, radiusX));
  context.beginPath();
  context.arc(0, 0, radiusX, 0, Math.PI * 2);
  context.fill();
  context.restore();

  context.save();
  context.translate(center.x, center.y);
  context.rotate(cluster.angle);
  context.strokeStyle = palette.orbit;
  context.lineWidth = emphasized ? 1 : 0.7;
  context.globalAlpha = emphasized ? 0.32 : quality === "overview" ? 0.15 : 0.08;
  context.beginPath();
  context.ellipse(0, 0, radiusX * 0.88, radiusY * 0.56, 0, 0, Math.PI * 1.64);
  context.stroke();
  if (cluster.nodeIds.size > 8) {
    context.globalAlpha *= 0.58;
    context.beginPath();
    context.ellipse(0, 0, radiusX * 0.58, radiusY * 0.9, cluster.seed * 0.7, 0.35, Math.PI * 1.75);
    context.stroke();
  }
  context.restore();
}

function drawEdge(
  context: CanvasRenderingContext2D,
  edge: GraphEdge,
  from: UniversePoint,
  to: UniversePoint,
  palette: Palette,
  highlighted: boolean,
  dimmed: boolean,
  quality: RenderQuality,
  time: number,
  animateParticle: boolean,
) {
  const control = edgeControlPoint(from, to, edge);
  context.save();
  context.strokeStyle = highlighted ? palette.edgeGlow : palette.edge;
  context.globalAlpha = highlighted ? 0.88 : dimmed ? 0.08 : quality === "overview" ? 0.52 : 0.58;
  context.lineWidth = highlighted ? 1.8 : quality === "detail" ? 0.82 : quality === "overview" ? 0.74 : 0.68;
  if (highlighted && quality !== "interaction") {
    context.shadowColor = palette.edgeGlow;
    context.shadowBlur = 9;
  }
  context.beginPath();
  context.moveTo(from.x, from.y);
  if (quality === "interaction") context.lineTo(to.x, to.y);
  else context.quadraticCurveTo(control.x, control.y, to.x, to.y);
  context.stroke();

  if (highlighted && animateParticle && quality !== "interaction") {
    const progress = (time * 0.00009 + hashString(edge.id)) % 1;
    const inverse = 1 - progress;
    const particleX =
      inverse * inverse * from.x +
      2 * inverse * progress * control.x +
      progress * progress * to.x;
    const particleY =
      inverse * inverse * from.y +
      2 * inverse * progress * control.y +
      progress * progress * to.y;
    context.fillStyle = palette.edgeGlow;
    context.shadowColor = palette.edgeGlow;
    context.shadowBlur = 12;
    context.beginPath();
    context.arc(particleX, particleY, 2.15, 0, Math.PI * 2);
    context.fill();
  }
  context.restore();
}

function drawSimpleStar(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  color: string,
  alpha: number,
) {
  context.save();
  context.globalAlpha = alpha;
  context.fillStyle = color;
  context.beginPath();
  context.arc(x, y, Math.max(1.25, radius * 0.28), 0, Math.PI * 2);
  context.fill();
  context.restore();
}

function drawNode(
  context: CanvasRenderingContext2D,
  screenNode: ScreenNode,
  palette: Palette,
  quality: RenderQuality,
  time: number,
  selected: boolean,
  highlighted: boolean,
  dimmed: boolean,
  representative: boolean,
) {
  const { node, x, y } = screenNode;
  const radius = representative && quality === "overview"
    ? screenNode.radius * 1.16
    : screenNode.radius;
  const color = stateColor(node, palette);
  const emphasized = selected || highlighted;
  context.save();
  context.globalAlpha = dimmed ? 0.25 : 1;
  if (quality === "interaction" && !emphasized) {
    const scale = node.type === "card" ? 0.42 : node.type === "key_point" ? 0.34 : 0.38;
    drawSimpleStar(context, x, y, radius / 0.28 * scale, color, dimmed ? 0.3 : 0.76);
  } else if (quality === "overview" && node.type === "card" && !representative && !emphasized) {
    drawSimpleStar(context, x, y, radius, color, dimmed ? 0.3 : 0.72);
  } else if (node.type === "source") {
    drawPlanet(context, x, y, radius, color, time, quality, emphasized);
  } else if (node.type === "note") {
    drawNoteAnchor(context, x, y, radius, color, quality, emphasized);
  } else if (node.type === "key_point") {
    drawSatellite(context, x, y, radius, color, time, hashString(node.id), quality, emphasized);
  } else {
    drawMainStar(
      context,
      node,
      x,
      y,
      radius,
      color,
      palette,
      time,
      emphasized,
      quality,
      hashString(node.id),
    );
  }
  if (selected) drawSelectionOrbit(context, x, y, radius, palette.selected, time);
  context.restore();
}

export const UnderstandingUniverse = forwardRef<
  UnderstandingUniverseHandle,
  UnderstandingUniverseProps
>(function UnderstandingUniverse(
  {
    nodes,
    edges,
    positions,
    selectedId = null,
    highlightedNodeIds = EMPTY_IDS,
    highlightedEdgeIds = EMPTY_IDS,
    onSelect,
    className = "",
    title = "理解星图",
    initialViewport = null,
    onViewportChange,
    storageNamespace,
  },
  ref,
) {
  // F18（round4）：offset 本地裁剪 key 可加工作区命名空间（调用方如星图页传
  // checkpoint.workspaceId），跨工作区/账户隔离，避免 key 串态。
  const offsetStorageKey = useMemo(
    () => (storageNamespace
      ? `${OFFSET_STORAGE_KEY}:${storageNamespace}`
      : OFFSET_STORAGE_KEY),
    [storageNamespace],
  );
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const readoutRef = useRef<HTMLOutputElement>(null);
  const tooltipPointRef = useRef<UniversePoint | null>(null);
  // 2026-08-14（文档 16 §15.6）：外部可注入初始视口（设备本地快照恢复）。
  const viewportRef = useRef<Viewport>(initialViewport ?? { offsetX: 0, offsetY: 0, zoom: 1 });
  // 视口变化上报（节流 250ms；仅在视口实际移动时触发）。
  const lastViewportReportRef = useRef<Viewport | null>(null);
  const lastViewportReportTimeRef = useRef(0);
  const viewportChangeCallbackRef = useRef(onViewportChange);
  viewportChangeCallbackRef.current = onViewportChange;
  const targetViewportRef = useRef<Viewport | null>(null);
  const targetViewportResponseRef = useRef(VIEWPORT_RESPONSE_MS);
  const sizeRef = useRef<CanvasSize>({ width: 0, height: 0, dpr: 1 });
  // 2026-08-11：canvas 的 viewport 位置缓存——getCanvasPoint 不再每 pointermove
  // 读 getBoundingClientRect()（forced layout）。resize/scroll（capture, passive）
  // 时刷新，pointermove 热路径只读此 ref。
  const canvasRectRef = useRef<DOMRect | null>(null);
  const dragRef = useRef<PointerDrag | null>(null);
  const activePointersRef = useRef<Map<number, UniversePoint>>(new Map());
  const pinchRef = useRef<PinchGesture | null>(null);
  const inertiaRef = useRef<PanInertia | null>(null);
  const customOffsetsRef = useRef<Map<string, UniversePoint>>(new Map());
  const customRevisionRef = useRef(0);
  const storageLoadedRef = useRef(false);
  const paletteRef = useRef<Palette>(DEFAULT_PALETTE);
  // F18（round4）：惰性初始化——useRef(makeDust(240)) 会在每次渲染求值函数实参
  //（240 次迭代的工厂每渲重跑）；改为首次渲染才构造，之后仅引用/reassign。
  const dustRef = useRef<DustStar[] | null>(null);
  if (dustRef.current === null) dustRef.current = makeDust(240);
  const backgroundCacheRef = useRef<BackgroundCache | null>(null);
  const sceneCacheRef = useRef<SceneCache | null>(null);
  const spatialIndexRef = useRef<ScreenSpatialIndex | null>(null);
  const labelWidthCacheRef = useRef<Map<string, number>>(new Map());
  const sceneRevisionRef = useRef(0);
  const interactionRef = useRef(false);
  const interactionRecoveryRef = useRef<number | null>(null);
  const animationDeadlineRef = useRef(0);
  const initializedRef = useRef(false);
  const reducedMotionRef = useRef(false);
  const documentVisibleRef = useRef(true);
  const frameRef = useRef<number | null>(null);
  const frameFallbackRef = useRef<number | null>(null);
  const lastFrameRef = useRef(0);
  const lastLoopTimeRef = useRef(0);
  const dirtyRef = useRef(true);
  const drawRef = useRef<(time: number) => void>(() => undefined);
  const loopRef = useRef<(time: number) => void>(() => undefined);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const id = useId().replace(/:/g, "");
  const summaryId = `universe-summary-${id}`;
  const liveId = `universe-live-${id}`;

  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const highlightedNodeSet = useMemo(() => new Set(highlightedNodeIds), [highlightedNodeIds]);
  const highlightedEdgeSet = useMemo(() => new Set(highlightedEdgeIds), [highlightedEdgeIds]);
  const positionedNodes = useMemo(
    () => nodes.filter((node) => finitePoint(positions[node.id])),
    [nodes, positions],
  );
  const validEdges = useMemo(
    () => edges.filter((edge) => nodeById.has(edge.from) && nodeById.has(edge.to)),
    [edges, nodeById],
  );
  const clusterModel = useMemo(() => {
    const adjacency = new Map<string, Set<string>>();
    const degree = new Map<string, number>();
    for (const node of positionedNodes) adjacency.set(node.id, new Set());
    for (const edge of validEdges) {
      if (!adjacency.has(edge.from) || !adjacency.has(edge.to)) continue;
      adjacency.get(edge.from)?.add(edge.to);
      adjacency.get(edge.to)?.add(edge.from);
      degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
      degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
    }

    const visited = new Set<string>();
    const clusters: UniverseCluster[] = [];
    const nodeToCluster = new Map<string, number>();
    const representativeIds = new Set<string>();
    const sortedIds = positionedNodes.map((node) => node.id).sort();
    for (const startId of sortedIds) {
      if (visited.has(startId)) continue;
      const queue = [startId];
      let queueCursor = 0;
      const memberIds: string[] = [];
      visited.add(startId);
      while (queueCursor < queue.length) {
        const nodeId = queue[queueCursor];
        queueCursor += 1;
        if (!nodeId) continue;
        memberIds.push(nodeId);
        for (const neighborId of adjacency.get(nodeId) ?? []) {
          if (visited.has(neighborId)) continue;
          visited.add(neighborId);
          queue.push(neighborId);
        }
      }

      let minX = Number.POSITIVE_INFINITY;
      let minY = Number.POSITIVE_INFINITY;
      let maxX = Number.NEGATIVE_INFINITY;
      let maxY = Number.NEGATIVE_INFINITY;
      let totalX = 0;
      let totalY = 0;
      let pointCount = 0;
      for (const nodeId of memberIds) {
        const point = positions[nodeId];
        if (!finitePoint(point)) continue;
        minX = Math.min(minX, point.x);
        minY = Math.min(minY, point.y);
        maxX = Math.max(maxX, point.x);
        maxY = Math.max(maxY, point.y);
        totalX += point.x;
        totalY += point.y;
        pointCount += 1;
      }
      if (!pointCount) continue;
      const candidates = memberIds
        .map((nodeId) => nodeById.get(nodeId))
        .filter((node): node is GraphNode => Boolean(node))
        .sort((left, right) => {
          const typeScore = (node: GraphNode) => node.type === "card" ? 4 : node.type === "note" ? 3 : node.type === "source" ? 2 : 1;
          const scoreDelta = typeScore(right) - typeScore(left);
          if (scoreDelta) return scoreDelta;
          const degreeDelta = (degree.get(right.id) ?? 0) - (degree.get(left.id) ?? 0);
          if (degreeDelta) return degreeDelta;
          return left.id.localeCompare(right.id);
        });
      const representativeId = candidates[0]?.id ?? startId;
      const id = clusters.length;
      const seed = hashString(memberIds.slice().sort().join("|"));
      const cluster: UniverseCluster = {
        id,
        nodeIds: new Set(memberIds),
        representativeId,
        center: { x: totalX / pointCount, y: totalY / pointCount },
        radiusX: Math.max(105, (maxX - minX) * 0.62 + 68 + seed * 46),
        radiusY: Math.max(82, (maxY - minY) * 0.58 + 54 + (1 - seed) * 38),
        angle: (seed - 0.5) * 0.72,
        seed,
      };
      clusters.push(cluster);
      representativeIds.add(representativeId);
      for (const nodeId of memberIds) nodeToCluster.set(nodeId, id);
    }
    return { clusters, nodeToCluster, representativeIds };
  }, [nodeById, positionedNodes, positions, validEdges]);
  // Once a star is selected its orbit, label and detail panel already carry
  // the context. Keeping the hover card on top would duplicate that content
  // and visually cover the newly revealed constellation.
  const hoveredNode = hoverId && hoverId !== selectedId
    ? nodeById.get(hoverId) ?? null
    : null;
  const selectedNode = selectedId ? nodeById.get(selectedId) ?? null : null;

  const scheduleFrame = useCallback(() => {
    if (
      !documentVisibleRef.current ||
      frameRef.current != null ||
      frameFallbackRef.current != null
    ) return;

    let settled = false;
    const flush = (time: number) => {
      if (settled) return;
      settled = true;
      if (frameRef.current != null) cancelAnimationFrame(frameRef.current);
      if (frameFallbackRef.current != null) window.clearTimeout(frameFallbackRef.current);
      frameRef.current = null;
      frameFallbackRef.current = null;
      loopRef.current(time);
    };
    frameRef.current = requestAnimationFrame(flush);
    // Some embedded or background browsers aggressively suppress rAF even
    // while reporting the document as visible. Keep the graph responsive and
    // render a low-frequency fallback instead of leaving a blank canvas.
    frameFallbackRef.current = window.setTimeout(() => flush(performance.now()), 80);
  }, []);

  const requestDraw = useCallback(() => {
    dirtyRef.current = true;
    scheduleFrame();
  }, [scheduleFrame]);

  const invalidateScene = useCallback(() => {
    sceneRevisionRef.current += 1;
    sceneCacheRef.current = null;
    spatialIndexRef.current = null;
    requestDraw();
  }, [requestDraw]);

  const markInteraction = useCallback((active: boolean, recoveryDelay = 130) => {
    interactionRef.current = active;
    if (interactionRecoveryRef.current != null) {
      window.clearTimeout(interactionRecoveryRef.current);
      interactionRecoveryRef.current = null;
    }
    if (active && recoveryDelay > 0) {
      interactionRecoveryRef.current = window.setTimeout(() => {
        interactionRef.current = false;
        interactionRecoveryRef.current = null;
        sceneRevisionRef.current += 1;
        sceneCacheRef.current = null;
        dirtyRef.current = true;
        scheduleFrame();
      }, recoveryDelay);
    }
  }, [scheduleFrame]);

  const persistOffsets = useCallback(() => {
    if (typeof window === "undefined" || !storageLoadedRef.current) return;
    try {
      const validIds = new Set(Object.keys(positions));
      const offsets: Record<string, UniversePoint> = {};
      for (const [nodeId, offset] of customOffsetsRef.current) {
        if (!validIds.has(nodeId) || !finitePoint(offset)) continue;
        if (Math.abs(offset.x) < OFFSET_EPSILON && Math.abs(offset.y) < OFFSET_EPSILON) continue;
        offsets[nodeId] = {
          x: Math.round(clamp(offset.x, -10_000, 10_000) * 100) / 100,
          y: Math.round(clamp(offset.y, -10_000, 10_000) * 100) / 100,
        };
      }
      if (Object.keys(offsets).length) {
        window.localStorage.setItem(offsetStorageKey, JSON.stringify({ version: 1, offsets }));
      } else {
        window.localStorage.removeItem(offsetStorageKey);
      }
    } catch {
      // Storage may be unavailable in private/embedded contexts. Dragging must
      // remain fully functional even when persistence is denied.
    }
  }, [positions, offsetStorageKey]);

  const getPosition = useCallback(
    (nodeId: string): UniversePoint | null => {
      const point = positions[nodeId];
      if (!finitePoint(point)) return null;
      const offset = customOffsetsRef.current.get(nodeId);
      return offset ? { x: point.x + offset.x, y: point.y + offset.y } : point;
    },
    [positions],
  );

  const setViewport = useCallback(
    (next: Viewport, smooth = false, responseMs = VIEWPORT_RESPONSE_MS) => {
      const normalized = { ...next, zoom: clamp(next.zoom, MIN_ZOOM, MAX_ZOOM) };
      if (smooth && !reducedMotionRef.current) {
        targetViewportRef.current = normalized;
        targetViewportResponseRef.current = Math.max(24, responseMs);
      } else {
        viewportRef.current = normalized;
        targetViewportRef.current = null;
        targetViewportResponseRef.current = VIEWPORT_RESPONSE_MS;
      }
      invalidateScene();
    },
    [invalidateScene],
  );

  const zoomAround = useCallback(
    (factor: number, anchorX?: number, anchorY?: number, smooth = false) => {
      const current = smooth && targetViewportRef.current
        ? targetViewportRef.current
        : viewportRef.current;
      const x = anchorX ?? sizeRef.current.width / 2;
      const y = anchorY ?? sizeRef.current.height / 2;
      const world = worldPoint(x, y, current);
      const zoom = clamp(current.zoom * factor, MIN_ZOOM, MAX_ZOOM);
      setViewport(
        {
          zoom,
          offsetX: x - world.x * zoom,
          offsetY: y - world.y * zoom,
        },
        smooth,
      );
    },
    [setViewport],
  );

  const fit = useCallback(() => {
    const activePositions: UniversePositions = {};
    for (const node of positionedNodes) {
      const point = getPosition(node.id);
      if (point) activePositions[node.id] = point;
    }
    setViewport(fitViewport(positionedNodes, activePositions, sizeRef.current), true);
  }, [getPosition, positionedNodes, setViewport]);

  const reset = useCallback(() => {
    customOffsetsRef.current.clear();
    customRevisionRef.current += 1;
    if (typeof window !== "undefined") {
      try {
        window.localStorage.removeItem(offsetStorageKey);
      } catch {
        // Ignore storage denial; the in-memory reset still succeeds.
      }
    }
    setViewport(fitViewport(positionedNodes, positions, sizeRef.current), true);
  }, [positionedNodes, positions, setViewport, offsetStorageKey]);

  const focusNode = useCallback(
    (nodeId: string, responseMs = FOCUS_RESPONSE_MS) => {
      if (!nodeById.has(nodeId)) return;
      const point = getPosition(nodeId);
      if (!point) return;
      const current = viewportRef.current;
      const zoom = clamp(Math.max(current.zoom, 1.15), MIN_ZOOM, 2.2);
      setViewport(
        {
          zoom,
          offsetX: sizeRef.current.width / 2 - point.x * zoom,
          offsetY: sizeRef.current.height / 2 - point.y * zoom,
        },
        true,
        responseMs,
      );
    },
    [getPosition, nodeById, setViewport],
  );

  useImperativeHandle(
    ref,
    () => ({
      zoomIn: () => zoomAround(ZOOM_FACTOR, undefined, undefined, true),
      zoomOut: () => zoomAround(1 / ZOOM_FACTOR, undefined, undefined, true),
      fit,
      reset,
      focusNode: (nodeId) => focusNode(nodeId),
    }),
    [fit, focusNode, reset, zoomAround],
  );

  const getCanvasPoint = useCallback((clientX: number, clientY: number) => {
    const rect = canvasRectRef.current;
    if (!rect) return null;
    return { x: clientX - rect.left, y: clientY - rect.top };
  }, []);

  const buildSpatialIndex = useCallback(() => {
    const viewport = viewportRef.current;
    const buckets = new Map<string, ScreenNode[]>();
    const cullMargin = 110;
    const { width, height } = sizeRef.current;
    for (const node of positionedNodes) {
      const emphasized =
        node.id === selectedId ||
        node.id === hoverId ||
        highlightedNodeSet.has(node.id);
      if (!nodeIsVisibleAtLod(node, viewport.zoom, clusterModel.representativeIds, emphasized)) {
        continue;
      }
      const world = getPosition(node.id);
      if (!world) continue;
      const point = screenPoint(world, viewport);
      if (
        point.x < -cullMargin ||
        point.y < -cullMargin ||
        point.x > width + cullMargin ||
        point.y > height + cullMargin
      ) continue;
      const screenNode = { node, ...point, radius: nodeRadius(node, viewport.zoom) };
      const key = labelGridKey(
        Math.floor(point.x / HIT_CELL_SIZE),
        Math.floor(point.y / HIT_CELL_SIZE),
      );
      const bucket = buckets.get(key);
      if (bucket) bucket.push(screenNode);
      else buckets.set(key, [screenNode]);
    }
    const index: ScreenSpatialIndex = {
      viewport: { ...viewport },
      nodesReference: positionedNodes,
      positionsReference: positions,
      customRevision: customRevisionRef.current,
      buckets,
    };
    spatialIndexRef.current = index;
    return index;
  }, [
    clusterModel.representativeIds,
    getPosition,
    highlightedNodeSet,
    hoverId,
    positionedNodes,
    positions,
    selectedId,
  ]);

  const hitTest = useCallback(
    (x: number, y: number) => {
      const viewport = viewportRef.current;
      let index = spatialIndexRef.current;
      if (
        !index ||
        index.nodesReference !== positionedNodes ||
        index.positionsReference !== positions ||
        index.customRevision !== customRevisionRef.current ||
        !viewportMatches(index.viewport, viewport)
      ) {
        index = buildSpatialIndex();
      }
      let match: ScreenNode | null = null;
      let bestDistance = Number.POSITIVE_INFINITY;
      const column = Math.floor(x / HIT_CELL_SIZE);
      const row = Math.floor(y / HIT_CELL_SIZE);
      for (let columnOffset = -1; columnOffset <= 1; columnOffset += 1) {
        for (let rowOffset = -1; rowOffset <= 1; rowOffset += 1) {
          const candidates = index.buckets.get(
            labelGridKey(column + columnOffset, row + rowOffset),
          );
          if (!candidates) continue;
          for (const screenNode of candidates) {
            const radius = screenNode.radius + 8;
            const distance = Math.hypot(x - screenNode.x, y - screenNode.y);
            if (distance <= radius && distance < bestDistance) {
              match = { ...screenNode, radius };
              bestDistance = distance;
            }
          }
        }
      }
      return match;
    },
    [buildSpatialIndex, positionedNodes, positions],
  );

  const updateHover = useCallback(
    (x: number, y: number, allowHover: boolean) => {
      const hit = allowHover ? hitTest(x, y) : null;
      const nextId = hit?.node.id ?? null;
      setHoverId((current) => (current === nextId ? current : nextId));
      const canvas = canvasRef.current;
      if (canvas) canvas.style.cursor = nextId ? "pointer" : dragRef.current ? "grabbing" : "grab";
      const tooltip = tooltipRef.current;
      tooltipPointRef.current = hit ? { x: hit.x, y: hit.y } : null;
      if (tooltip && hit) {
        const tx = clamp(hit.x + 18, 12, Math.max(12, sizeRef.current.width - 236));
        const ty = clamp(hit.y - 10, 12, Math.max(12, sizeRef.current.height - 104));
        tooltip.style.transform = `translate3d(${tx}px, ${ty}px, 0)`;
      }
      if (nextId !== hoverId) requestDraw();
      if (nextId && nextId !== hoverId && !reducedMotionRef.current) {
        animationDeadlineRef.current = performance.now() + 720;
      }
      return hit;
    },
    [hitTest, hoverId, requestDraw],
  );

  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0) return;
    const point = getCanvasPoint(event.clientX, event.clientY);
    if (!point) return;
    targetViewportRef.current = null;
    inertiaRef.current = null;
    markInteraction(true, 0);
    activePointersRef.current.set(event.pointerId, point);
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.style.cursor = "grabbing";

    if (activePointersRef.current.size >= 2) {
      pinchRef.current = readPinchGesture(activePointersRef.current);
      dragRef.current = null;
      setHoverId(null);
      return;
    }

    const hit = hitTest(point.x, point.y);
    dragRef.current = {
      id: event.pointerId,
      nodeId: hit?.node.id ?? null,
      startX: point.x,
      startY: point.y,
      lastX: point.x,
      lastY: point.y,
      lastTime: performance.now(),
      velocityX: 0,
      velocityY: 0,
      moved: false,
    };
  }, [getCanvasPoint, hitTest, markInteraction]);

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      const point = getCanvasPoint(event.clientX, event.clientY);
      if (!point) return;
      if (activePointersRef.current.has(event.pointerId)) {
        activePointersRef.current.set(event.pointerId, point);
      }

      if (activePointersRef.current.size >= 2) {
        const nextPinch = readPinchGesture(activePointersRef.current);
        const previousPinch = pinchRef.current;
        if (nextPinch && previousPinch) {
          const current = viewportRef.current;
          const anchor = worldPoint(previousPinch.center.x, previousPinch.center.y, current);
          const zoom = clamp(
            current.zoom * (nextPinch.distance / previousPinch.distance),
            MIN_ZOOM,
            MAX_ZOOM,
          );
          viewportRef.current = {
            zoom,
            offsetX: nextPinch.center.x - anchor.x * zoom,
            offsetY: nextPinch.center.y - anchor.y * zoom,
          };
          targetViewportRef.current = null;
          invalidateScene();
        }
        pinchRef.current = nextPinch;
        dragRef.current = null;
        setHoverId(null);
        return;
      }

      const drag = dragRef.current;
      if (drag && drag.id === event.pointerId) {
        const dx = point.x - drag.lastX;
        const dy = point.y - drag.lastY;
        const now = performance.now();
        const elapsed = Math.max(8, now - drag.lastTime);
        const instantVelocityX = dx / elapsed;
        const instantVelocityY = dy / elapsed;
        drag.velocityX = drag.velocityX * 0.68 + instantVelocityX * 0.32;
        drag.velocityY = drag.velocityY * 0.68 + instantVelocityY * 0.32;
        drag.lastTime = now;
        if (!drag.moved && Math.hypot(point.x - drag.startX, point.y - drag.startY) > 4) {
          drag.moved = true;
          setHoverId(null);
        }
        if (drag.moved) {
          if (drag.nodeId) {
            const offset = customOffsetsRef.current.get(drag.nodeId) ?? { x: 0, y: 0 };
            customOffsetsRef.current.set(drag.nodeId, {
              x: offset.x + dx / viewportRef.current.zoom,
              y: offset.y + dy / viewportRef.current.zoom,
            });
            customRevisionRef.current += 1;
          } else {
            viewportRef.current = {
              ...viewportRef.current,
              offsetX: viewportRef.current.offsetX + dx,
              offsetY: viewportRef.current.offsetY + dy,
            };
          }
          invalidateScene();
        }
        drag.lastX = point.x;
        drag.lastY = point.y;
        return;
      }
      updateHover(point.x, point.y, event.pointerType === "mouse");
    },
    [getCanvasPoint, invalidateScene, updateHover],
  );

  const finishPointer = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>, cancelled: boolean) => {
      const drag = dragRef.current;
      const point = getCanvasPoint(event.clientX, event.clientY);
      const wasPinching = pinchRef.current != null || activePointersRef.current.size > 1;
      activePointersRef.current.delete(event.pointerId);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      if (wasPinching) {
        pinchRef.current = null;
        dragRef.current = null;
        markInteraction(false);
        invalidateScene();
        event.currentTarget.style.cursor = "grab";
        return;
      }
      if (!drag || drag.id !== event.pointerId) return;
      dragRef.current = null;
      markInteraction(false);
      event.currentTarget.style.cursor = "grab";
      if (!cancelled && !drag.moved && point) onSelect(hitTest(point.x, point.y)?.node.id ?? null);
      if (drag.moved && drag.nodeId) persistOffsets();
      if (drag.moved && !drag.nodeId && !cancelled && !reducedMotionRef.current) {
        const speed = Math.hypot(drag.velocityX, drag.velocityY);
        if (speed > 0.035) {
          inertiaRef.current = {
            velocityX: clamp(drag.velocityX, -2.1, 2.1),
            velocityY: clamp(drag.velocityY, -2.1, 2.1),
            lastTime: performance.now(),
          };
        }
      }
      invalidateScene();
      if (point) updateHover(point.x, point.y, event.pointerType === "mouse");
    },
    [getCanvasPoint, hitTest, invalidateScene, markInteraction, onSelect, persistOffsets, updateHover],
  );

  const handleWheel = useCallback(
    (event: ReactWheelEvent<HTMLCanvasElement>) => {
      event.preventDefault();
      const point = getCanvasPoint(event.clientX, event.clientY);
      if (!point) return;
      const intensity = event.deltaMode === 1 ? 0.06 : 0.00135;
      inertiaRef.current = null;
      markInteraction(true, 180);
      const factor = clamp(Math.exp(-event.deltaY * intensity), 0.76, 1.32);
      zoomAround(factor, point.x, point.y, true);
    },
    [getCanvasPoint, markInteraction, zoomAround],
  );

  const handleDoubleClick = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      event.preventDefault();
      const point = getCanvasPoint(event.clientX, event.clientY);
      if (!point) return;
      const hit = hitTest(point.x, point.y);
      if (!hit) return;
      inertiaRef.current = null;
      animationDeadlineRef.current = reducedMotionRef.current
        ? 0
        : performance.now() + 2_400;
      onSelect(hit.node.id);
      // Preserve full-quality feedback for the selected body while the camera
      // converges, and use a tighter response than generic fit/zoom motions.
      // The first frame now carries the selection orbit instead of waiting for
      // the interaction-quality camera pass to settle.
      focusNode(hit.node.id, DOUBLE_CLICK_RESPONSE_MS);
    },
    [focusNode, getCanvasPoint, hitTest, onSelect],
  );

  drawRef.current = (time: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const { width, height, dpr } = sizeRef.current;
    if (width <= 0 || height <= 0) return;
    const viewport = viewportRef.current;
    const palette = paletteRef.current;
    const animatedTime = reducedMotionRef.current ? 0 : time;
    const quality = renderQuality(
      viewport.zoom,
      positionedNodes.length,
      interactionRef.current || Boolean(targetViewportRef.current || inertiaRef.current || dragRef.current),
    );
    const readout = readoutRef.current;
    if (readout) {
      const percent = `${Math.round(viewport.zoom * 100)}%`;
      if (readout.textContent !== percent) readout.textContent = percent;
    }

    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);

    const currentPaletteKey = paletteKey(palette);
    const backgroundKey = `${width}:${height}:${dpr}:${currentPaletteKey}`;
    let backgroundCache = backgroundCacheRef.current;
    if (!backgroundCache || backgroundCache.key !== backgroundKey) {
      const backgroundCanvas = canvasLayer(width, height, dpr);
      const backgroundContext = backgroundCanvas.getContext("2d");
      if (backgroundContext) {
        backgroundContext.setTransform(dpr, 0, 0, dpr, 0, 0);
        const background = backgroundContext.createLinearGradient(0, 0, width, height);
        background.addColorStop(0, palette.spaceTop);
        background.addColorStop(1, palette.spaceBottom);
        backgroundContext.fillStyle = background;
        backgroundContext.fillRect(0, 0, width, height);

        const nebula = backgroundContext.createRadialGradient(
          width * 0.16,
          height * 0.2,
          0,
          width * 0.16,
          height * 0.2,
          Math.max(width, height) * 0.66,
        );
        nebula.addColorStop(0, palette.nebulaA);
        nebula.addColorStop(1, "rgba(0,0,0,0)");
        backgroundContext.fillStyle = nebula;
        backgroundContext.fillRect(0, 0, width, height);
        const nebulaTwo = backgroundContext.createRadialGradient(
          width * 0.86,
          height * 0.82,
          0,
          width * 0.86,
          height * 0.82,
          Math.max(width, height) * 0.54,
        );
        nebulaTwo.addColorStop(0, palette.nebulaB);
        nebulaTwo.addColorStop(1, "rgba(0,0,0,0)");
        backgroundContext.fillStyle = nebulaTwo;
        backgroundContext.fillRect(0, 0, width, height);
        backgroundContext.fillStyle = palette.dust;
        // dustRef 已惰性初始化（首次渲染保证非空）。
        for (const star of dustRef.current!) {
          const x = star.x * width;
          const y = star.y * height;
          backgroundContext.globalAlpha = star.alpha * (0.72 + Math.sin(star.phase) * 0.18);
          backgroundContext.beginPath();
          backgroundContext.arc(x, y, star.size, 0, Math.PI * 2);
          backgroundContext.fill();
        }
        backgroundContext.globalAlpha = 1;
      }
      backgroundCache = { key: backgroundKey, canvas: backgroundCanvas };
      backgroundCacheRef.current = backgroundCache;
    }
    context.drawImage(
      backgroundCache.canvas,
      0,
      0,
      backgroundCache.canvas.width,
      backgroundCache.canvas.height,
      0,
      0,
      width,
      height,
    );

    const sceneKey = [
      sceneRevisionRef.current,
      width,
      height,
      dpr,
      viewport.offsetX.toFixed(2),
      viewport.offsetY.toFixed(2),
      viewport.zoom.toFixed(4),
      quality,
      currentPaletteKey,
    ].join(":");
    let scene = sceneCacheRef.current;
    if (!scene || scene.key !== sceneKey) {
      const layer = canvasLayer(width, height, dpr);
      const layerContext = layer.getContext("2d");
      const screenNodes = new Map<string, ScreenNode>();
      const cullMargin = 110;
      for (const node of positionedNodes) {
        const emphasized =
          node.id === selectedId ||
          node.id === hoverId ||
          highlightedNodeSet.has(node.id);
        if (!nodeIsVisibleAtLod(node, viewport.zoom, clusterModel.representativeIds, emphasized)) {
          continue;
        }
        const world = getPosition(node.id);
        if (!world) continue;
        const point = screenPoint(world, viewport);
        if (
          point.x < -cullMargin ||
          point.y < -cullMargin ||
          point.x > width + cullMargin ||
          point.y > height + cullMargin
        ) continue;
        screenNodes.set(node.id, { node, ...point, radius: nodeRadius(node, viewport.zoom) });
      }

      const buckets = new Map<string, ScreenNode[]>();
      for (const screenNode of screenNodes.values()) {
        const key = labelGridKey(
          Math.floor(screenNode.x / HIT_CELL_SIZE),
          Math.floor(screenNode.y / HIT_CELL_SIZE),
        );
        const bucket = buckets.get(key);
        if (bucket) bucket.push(screenNode);
        else buckets.set(key, [screenNode]);
      }
      spatialIndexRef.current = {
        viewport: { ...viewport },
        nodesReference: positionedNodes,
        positionsReference: positions,
        customRevision: customRevisionRef.current,
        buckets,
      };

      const dynamicNodeIds = new Set<string>();
      if (selectedId) dynamicNodeIds.add(selectedId);
      if (hoverId) dynamicNodeIds.add(hoverId);
      for (const nodeId of highlightedNodeSet) dynamicNodeIds.add(nodeId);
      const dynamicEdges: GraphEdge[] = [];

      if (layerContext) {
        layerContext.setTransform(dpr, 0, 0, dpr, 0, 0);
        const selectedClusterId = selectedId ? clusterModel.nodeToCluster.get(selectedId) : null;
        for (const cluster of clusterModel.clusters) {
          const center = screenPoint(cluster.center, viewport);
          const radius = Math.max(cluster.radiusX, cluster.radiusY) * viewport.zoom;
          if (
            center.x + radius < -cullMargin ||
            center.x - radius > width + cullMargin ||
            center.y + radius < -cullMargin ||
            center.y - radius > height + cullMargin
          ) continue;
          drawClusterEnvelope(
            layerContext,
            cluster,
            viewport,
            palette,
            selectedClusterId === cluster.id,
            quality,
          );
        }

        for (const edge of validEdges) {
          const highlighted = highlightedEdgeSet.has(edge.id);
          if (highlighted) {
            dynamicEdges.push(edge);
            continue;
          }
          const fromNode = nodeById.get(edge.from);
          const toNode = nodeById.get(edge.to);
          if (!fromNode || !toNode) continue;
          if (!screenNodes.has(edge.from) || !screenNodes.has(edge.to)) continue;
          if (
            quality === "interaction" &&
            validEdges.length > 900 &&
            hashString(edge.id) > (validEdges.length > 2_500 ? 0.32 : 0.56)
          ) {
            continue;
          }
          if (quality === "overview") {
            if (
              (fromNode.type === "key_point" || toNode.type === "key_point") &&
              hashString(edge.id) > 0.72
            ) continue;
          } else if (
            quality === "balanced" &&
            viewport.zoom < 0.46 &&
            (fromNode.type === "key_point" || toNode.type === "key_point")
          ) continue;
          const fromWorld = getPosition(edge.from);
          const toWorld = getPosition(edge.to);
          if (!fromWorld || !toWorld) continue;
          const from = screenPoint(fromWorld, viewport);
          const to = screenPoint(toWorld, viewport);
          if (
            Math.max(from.x, to.x) < -cullMargin ||
            Math.min(from.x, to.x) > width + cullMargin ||
            Math.max(from.y, to.y) < -cullMargin ||
            Math.min(from.y, to.y) > height + cullMargin
          ) continue;
          drawEdge(
            layerContext,
            edge,
            from,
            to,
            palette,
            false,
            Boolean(selectedId),
            quality,
            0,
            false,
          );
        }
      }

      const priority = (screenNode: ScreenNode) => {
        const node = screenNode.node;
        if (node.id === selectedId) return 100;
        if (node.id === hoverId) return 95;
        if (highlightedNodeSet.has(node.id)) return 80;
        if (clusterModel.representativeIds.has(node.id)) return 60;
        if (node.type === "card") return 40;
        if (node.type === "note") return 26;
        if (node.type === "source") return 20;
        return 10;
      };
      const orderedNodes = [...screenNodes.values()].sort((left, right) => priority(left) - priority(right));
      const labelCandidates = orderedNodes.slice().sort((left, right) => priority(right) - priority(left));
      const occupiedCells = new Set<string>();
      const labelPlacements: LabelPlacement[] = [];
      const labelBudget = quality === "interaction"
        ? selectedId ? 1 : 0
        : quality === "overview"
          ? clamp(Math.floor((width * height) / 42_000), 7, 22)
          : quality === "balanced"
            ? clamp(Math.floor((width * height) / 18_000), 18, 56)
            : clamp(Math.floor((width * height) / 10_500), 28, 110);
      if (layerContext && labelBudget > 0) {
        layerContext.font = '500 12px "Noto Sans SC", "PingFang SC", sans-serif';
        for (const screenNode of labelCandidates) {
          if (labelPlacements.length >= labelBudget) break;
          const { node, x, y, radius } = screenNode;
          const selected = node.id === selectedId;
          const hovered = node.id === hoverId;
          const highlighted = highlightedNodeSet.has(node.id);
          const representative = clusterModel.representativeIds.has(node.id);
          const forced = selected || hovered || highlighted;
          const eligible = forced ||
            (quality === "overview" && representative) ||
            (quality === "balanced" && (representative || node.type === "card")) ||
            quality === "detail";
          if (!eligible) continue;
          const maxLength = quality === "overview" ? 12 : node.type === "key_point" ? 16 : 21;
          const text = truncateLabel(node.label, maxLength);
          let labelWidth = labelWidthCacheRef.current.get(text);
          if (labelWidth == null) {
            labelWidth = Math.min(190, layerContext.measureText(text).width + 18);
            labelWidthCacheRef.current.set(text, labelWidth);
          }
          const gap = radius + 17;
          const candidates: UniversePoint[] = [
            { x, y: y + gap },
            { x: x + gap + labelWidth / 2, y },
            { x, y: y - gap },
            { x: x - gap - labelWidth / 2, y },
          ];
          let placement: UniversePoint | null = null;
          let placementCells: string[] = [];
          for (const candidate of candidates) {
            const left = candidate.x - labelWidth / 2;
            const top = candidate.y - 10;
            if (left < 8 || left + labelWidth > width - 8 || top < 8 || top + 20 > height - 8) {
              continue;
            }
            const cells = rectCells(left - 5, top - 3, labelWidth + 10, 26);
            if (cells.every((cell) => !occupiedCells.has(cell))) {
              placement = candidate;
              placementCells = cells;
              break;
            }
          }
          if (!placement && forced) {
            placement = {
              x: clamp(x, labelWidth / 2 + 8, width - labelWidth / 2 - 8),
              y: clamp(y + gap, 18, height - 18),
            };
            placementCells = rectCells(
              placement.x - labelWidth / 2,
              placement.y - 10,
              labelWidth,
              20,
            );
          }
          if (!placement) continue;
          for (const cell of placementCells) occupiedCells.add(cell);
          const dimmed = Boolean(selectedId || highlightedNodeSet.size) && !forced;
          labelPlacements.push({
            nodeId: node.id,
            text,
            x: placement.x,
            y: placement.y,
            width: labelWidth,
            alpha: dimmed ? 0.26 : forced ? 1 : quality === "overview" ? 0.68 : 0.8,
            color: selected ? palette.selected : palette.text,
            dynamic: dynamicNodeIds.has(node.id),
          });
        }
      }

      if (layerContext) {
        for (const screenNode of orderedNodes) {
          if (dynamicNodeIds.has(screenNode.node.id)) continue;
          const highlighted = highlightedNodeSet.has(screenNode.node.id);
          const dimmed = Boolean(selectedId || highlightedNodeSet.size) && !highlighted;
          drawNode(
            layerContext,
            screenNode,
            palette,
            quality,
            0,
            false,
            highlighted,
            dimmed,
            clusterModel.representativeIds.has(screenNode.node.id),
          );
        }
        for (const label of labelPlacements) {
          if (label.dynamic) continue;
          drawRoundedLabel(
            layerContext,
            label.text,
            label.x,
            label.y,
            label.width,
            label.color,
            palette.labelBackdrop,
            label.alpha,
          );
        }
      }
      scene = {
        key: sceneKey,
        canvas: layer,
        screenNodes,
        dynamicNodes: orderedNodes.filter((screenNode) => dynamicNodeIds.has(screenNode.node.id)),
        dynamicEdges,
        dynamicLabels: labelPlacements.filter((label) => label.dynamic),
      };
      sceneCacheRef.current = scene;
    }

    if (hoverId) {
      const hoveredScreenNode = scene.screenNodes.get(hoverId);
      const tooltip = tooltipRef.current;
      if (hoveredScreenNode && tooltip) {
        tooltipPointRef.current = { x: hoveredScreenNode.x, y: hoveredScreenNode.y };
        const tx = clamp(
          hoveredScreenNode.x + 18,
          12,
          Math.max(12, width - 236),
        );
        const ty = clamp(
          hoveredScreenNode.y - 10,
          12,
          Math.max(12, height - 104),
        );
        tooltip.style.transform = `translate3d(${tx}px, ${ty}px, 0)`;
      }
    }

    context.drawImage(
      scene.canvas,
      0,
      0,
      scene.canvas.width,
      scene.canvas.height,
      0,
      0,
      width,
      height,
    );

    for (const edge of scene.dynamicEdges) {
      const fromWorld = getPosition(edge.from);
      const toWorld = getPosition(edge.to);
      if (!fromWorld || !toWorld) continue;
      drawEdge(
        context,
        edge,
        screenPoint(fromWorld, viewport),
        screenPoint(toWorld, viewport),
        palette,
        true,
        false,
        quality,
        animatedTime,
        !reducedMotionRef.current,
      );
    }
    for (const screenNode of scene.dynamicNodes) {
      const selected = screenNode.node.id === selectedId;
      const highlighted = highlightedNodeSet.has(screenNode.node.id);
      drawNode(
        context,
        screenNode,
        palette,
        quality,
        animatedTime,
        selected,
        highlighted,
        false,
        clusterModel.representativeIds.has(screenNode.node.id),
      );
    }
    for (const label of scene.dynamicLabels) {
      drawRoundedLabel(
        context,
        label.text,
        label.x,
        label.y,
        label.width,
        label.color,
        palette.labelBackdrop,
        label.alpha,
      );
    }
  };

  loopRef.current = (time: number) => {
    frameRef.current = null;
    if (!documentVisibleRef.current) return;
    const elapsed = clamp(time - (lastLoopTimeRef.current || time - 16), 1, 48);
    lastLoopTimeRef.current = time;

    // 2026-08-14（文档 16 §15.6）：视口变化上报（节流 250ms）——仅视口
    // 实际移动时触发，供本地快照/恢复消费。
    {
      const vp = viewportRef.current;
      const last = lastViewportReportRef.current;
      if (
        viewportChangeCallbackRef.current
        && (lastViewportReportTimeRef.current === 0 || time - lastViewportReportTimeRef.current >= 250)
        && (!last
          || Math.abs(last.offsetX - vp.offsetX) > 0.5
          || Math.abs(last.offsetY - vp.offsetY) > 0.5
          || Math.abs(last.zoom - vp.zoom) > 0.001)
      ) {
        lastViewportReportRef.current = vp;
        lastViewportReportTimeRef.current = time;
        viewportChangeCallbackRef.current({ zoom: vp.zoom, offsetX: vp.offsetX, offsetY: vp.offsetY });
      }
    }

    const target = targetViewportRef.current;
    let moving = false;
    if (target) {
      const current = viewportRef.current;
      const amount = reducedMotionRef.current
        ? 1
        : 1 - Math.exp(-elapsed / targetViewportResponseRef.current);
      const next = {
        offsetX: current.offsetX + (target.offsetX - current.offsetX) * amount,
        offsetY: current.offsetY + (target.offsetY - current.offsetY) * amount,
        zoom: current.zoom + (target.zoom - current.zoom) * amount,
      };
      const distance = Math.abs(next.offsetX - target.offsetX) + Math.abs(next.offsetY - target.offsetY) + Math.abs(next.zoom - target.zoom) * 100;
      if (distance < 0.35) {
        viewportRef.current = target;
        targetViewportRef.current = null;
      } else {
        viewportRef.current = next;
        moving = true;
      }
      dirtyRef.current = true;
    }

    let gliding = false;
    const inertia = inertiaRef.current;
    if (inertia && !targetViewportRef.current && !dragRef.current) {
      const inertiaElapsed = clamp(time - inertia.lastTime, 1, 34);
      inertia.lastTime = time;
      viewportRef.current = {
        ...viewportRef.current,
        offsetX: viewportRef.current.offsetX + inertia.velocityX * inertiaElapsed,
        offsetY: viewportRef.current.offsetY + inertia.velocityY * inertiaElapsed,
      };
      const decay = Math.exp(-inertiaElapsed / 235);
      inertia.velocityX *= decay;
      inertia.velocityY *= decay;
      if (Math.hypot(inertia.velocityX, inertia.velocityY) < 0.012) {
        inertiaRef.current = null;
      } else {
        gliding = true;
      }
      dirtyRef.current = true;
    }

    const animate =
      !reducedMotionRef.current &&
      Boolean(selectedId) &&
      time < animationDeadlineRef.current;
    const frameInterval = positionedNodes.length > 1_200
      ? 1000 / 15
      : positionedNodes.length > 500
        ? LARGE_ACTIVE_FRAME_INTERVAL
        : ACTIVE_FRAME_INTERVAL;
    if (dirtyRef.current || (animate && time - lastFrameRef.current >= frameInterval)) {
      drawRef.current(time);
      lastFrameRef.current = time;
      dirtyRef.current = false;
    }

    if (animate || moving || gliding || dirtyRef.current) {
      scheduleFrame();
    }
  };

  useEffect(() => {
    const validIds = Object.keys(positions);
    if (!validIds.length || typeof window === "undefined") return;
    const validIdSet = new Set(validIds);
    let changed = false;
    if (!storageLoadedRef.current) {
      storageLoadedRef.current = true;
      try {
        const raw = window.localStorage.getItem(offsetStorageKey);
        if (raw) {
          const parsed = JSON.parse(raw) as {
            version?: unknown;
            offsets?: Record<string, UniversePoint>;
          };
          if (parsed.version === 1 && parsed.offsets && typeof parsed.offsets === "object") {
            for (const [nodeId, offset] of Object.entries(parsed.offsets)) {
              if (!validIdSet.has(nodeId) || !finitePoint(offset)) {
                changed = true;
                continue;
              }
              if (Math.abs(offset.x) < OFFSET_EPSILON && Math.abs(offset.y) < OFFSET_EPSILON) {
                changed = true;
                continue;
              }
              customOffsetsRef.current.set(nodeId, {
                x: clamp(offset.x, -10_000, 10_000),
                y: clamp(offset.y, -10_000, 10_000),
              });
              changed = true;
            }
          } else {
            changed = true;
          }
        }
      } catch {
        // Invalid or inaccessible storage should never block the graph.
        try {
          window.localStorage.removeItem(offsetStorageKey);
        } catch {
          // Storage is unavailable; there is nothing else to clean up.
        }
      }
    }

    for (const nodeId of customOffsetsRef.current.keys()) {
      if (validIdSet.has(nodeId)) continue;
      customOffsetsRef.current.delete(nodeId);
      changed = true;
    }
    if (changed) {
      customRevisionRef.current += 1;
      const activePositions: UniversePositions = {};
      for (const node of positionedNodes) {
        const point = positions[node.id];
        if (!finitePoint(point)) continue;
        const offset = customOffsetsRef.current.get(node.id);
        activePositions[node.id] = offset
          ? { x: point.x + offset.x, y: point.y + offset.y }
          : point;
      }
      viewportRef.current = fitViewport(positionedNodes, activePositions, sizeRef.current);
      invalidateScene();
      persistOffsets();
    }
  }, [invalidateScene, persistOffsets, positionedNodes, positions, offsetStorageKey]);

  useEffect(() => {
    const root = rootRef.current;
    const canvas = canvasRef.current;
    if (!root || !canvas) return;

    const resize = () => {
      const rect = root.getBoundingClientRect();
      const width = Math.max(1, rect.width);
      const height = Math.max(1, rect.height);
      const dpr = Math.min(DPR_LIMIT, Math.max(1, window.devicePixelRatio || 1));
      const previous = sizeRef.current;
      sizeRef.current = { width, height, dpr };
      // 缓存 viewport 位置（canvas 与 root 同为 inset:0，用 root rect 即可）
      canvasRectRef.current = rect;
      canvas.width = Math.ceil(width * dpr);
      canvas.height = Math.ceil(height * dpr);
      dustRef.current = makeDust(clamp(Math.round((width * height) / 3600), 130, 360));
      paletteRef.current = readPalette(root);
      backgroundCacheRef.current = null;
      sceneCacheRef.current = null;
      spatialIndexRef.current = null;
      tooltipPointRef.current = null;
      setHoverId(null);

      if (!initializedRef.current) {
        const activePositions: UniversePositions = {};
        for (const node of positionedNodes) {
          const point = getPosition(node.id);
          if (point) activePositions[node.id] = point;
        }
        viewportRef.current = fitViewport(positionedNodes, activePositions, sizeRef.current);
        initializedRef.current = true;
      } else {
        viewportRef.current = {
          ...viewportRef.current,
          offsetX: viewportRef.current.offsetX + (width - previous.width) / 2,
          offsetY: viewportRef.current.offsetY + (height - previous.height) / 2,
        };
      }
      invalidateScene();
    };

    const refreshCanvasRect = () => {
      canvasRectRef.current = root.getBoundingClientRect();
    };
    // 页面/容器滚动会改变 canvas 的 viewport 位置；capture+passive 监听刷新缓存
    const onScroll = () => refreshCanvasRect();
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    const observer = new ResizeObserver(resize);
    observer.observe(root);
    resize();
    return () => {
      observer.disconnect();
      document.removeEventListener("scroll", onScroll, { capture: true } as EventListenerOptions);
    };
  }, [getPosition, invalidateScene, positionedNodes]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const refreshPalette = () => {
      paletteRef.current = readPalette(root);
      backgroundCacheRef.current = null;
      labelWidthCacheRef.current.clear();
      invalidateScene();
    };
    const observer = new MutationObserver(refreshPalette);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme", "style"] });
    if (document.body) observer.observe(document.body, { attributes: true, attributeFilter: ["class", "data-theme", "style"] });
    return () => observer.disconnect();
  }, [invalidateScene]);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updateMotion = () => {
      reducedMotionRef.current = query.matches;
      requestDraw();
    };
    const updateVisibility = () => {
      documentVisibleRef.current = document.visibilityState !== "hidden";
      if (documentVisibleRef.current) requestDraw();
      else if (frameRef.current != null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      if (!documentVisibleRef.current && frameFallbackRef.current != null) {
        window.clearTimeout(frameFallbackRef.current);
        frameFallbackRef.current = null;
      }
    };
    updateMotion();
    updateVisibility();
    query.addEventListener("change", updateMotion);
    document.addEventListener("visibilitychange", updateVisibility);
    return () => {
      query.removeEventListener("change", updateMotion);
      document.removeEventListener("visibilitychange", updateVisibility);
    };
  }, [requestDraw]);

  useEffect(() => {
    if (selectedId && !reducedMotionRef.current) {
      animationDeadlineRef.current = performance.now() + 2_400;
    } else if (!selectedId) {
      animationDeadlineRef.current = 0;
    }
    invalidateScene();
  }, [
    clusterModel,
    hoverId,
    highlightedEdgeSet,
    highlightedNodeSet,
    invalidateScene,
    positions,
    selectedId,
    validEdges,
    positionedNodes,
  ]);

  useEffect(() => {
    const tooltip = tooltipRef.current;
    const point = tooltipPointRef.current;
    if (!tooltip || !point || !hoverId) return;
    const tx = clamp(point.x + 18, 12, Math.max(12, sizeRef.current.width - 236));
    const ty = clamp(point.y - 10, 12, Math.max(12, sizeRef.current.height - 104));
    tooltip.style.transform = `translate3d(${tx}px, ${ty}px, 0)`;
  }, [hoverId]);

  useEffect(() => {
    return () => {
      if (frameRef.current != null) cancelAnimationFrame(frameRef.current);
      if (frameFallbackRef.current != null) window.clearTimeout(frameFallbackRef.current);
      frameRef.current = null;
      frameFallbackRef.current = null;
      if (interactionRecoveryRef.current != null) {
        window.clearTimeout(interactionRecoveryRef.current);
        interactionRecoveryRef.current = null;
      }
      inertiaRef.current = null;
    };
  }, []);

  const classNames = ["universe-canvas-root", className].filter(Boolean).join(" ");
  const selectedAnnouncement = selectedNode
    ? `已选择${TYPE_LABEL[selectedNode.type]}：${selectedNode.label}，状态${STATE_LABEL[selectedNode.state ?? ""] ?? "未设置"}`
    : "未选择知识节点";

  return (
    <div
      ref={rootRef}
      className={classNames}
      role="region"
      aria-label={title}
      aria-describedby={summaryId}
    >
      <canvas
        ref={canvasRef}
        className="universe-canvas-surface"
        aria-hidden="true"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={(event) => finishPointer(event, false)}
        onPointerCancel={(event) => finishPointer(event, true)}
        onPointerLeave={() => {
          if (!dragRef.current) {
            setHoverId(null);
            requestDraw();
          }
        }}
        onDoubleClick={handleDoubleClick}
        onWheel={handleWheel}
      />

      {hoveredNode ? (
        <div ref={tooltipRef} className="universe-canvas-tooltip" role="tooltip">
          <span className={`universe-canvas-tooltip-mark is-${hoveredNode.type}`} aria-hidden="true" />
          <span className="universe-canvas-tooltip-copy">
            <strong>{hoveredNode.label}</strong>
            <span>
              {TYPE_LABEL[hoveredNode.type]}
              {hoveredNode.state ? ` · ${STATE_LABEL[hoveredNode.state] ?? hoveredNode.state}` : ""}
            </span>
          </span>
        </div>
      ) : null}

      <div className="universe-canvas-controls" aria-label="星图视野控制">
        <button
          type="button"
          className="universe-canvas-control"
          title="放大星图"
          aria-label="放大星图"
          onClick={() => zoomAround(ZOOM_FACTOR, undefined, undefined, true)}
        >
          <span aria-hidden="true">＋</span>
        </button>
        <output ref={readoutRef} className="universe-canvas-readout" aria-label="当前缩放比例">
          100%
        </output>
        <button
          type="button"
          className="universe-canvas-control"
          title="缩小星图"
          aria-label="缩小星图"
          onClick={() => zoomAround(1 / ZOOM_FACTOR, undefined, undefined, true)}
        >
          <span aria-hidden="true">−</span>
        </button>
        <button
          type="button"
          className="universe-canvas-control universe-canvas-control-fit"
          title="重置节点位置并适配全部星图"
          aria-label="重置节点位置并适配全部星图"
          onClick={reset}
        >
          <span aria-hidden="true">适配</span>
        </button>
      </div>

      <p id={summaryId} className="universe-canvas-a11y-summary">
        {`理解星图包含 ${positionedNodes.length} 个知识节点和 ${validEdges.length} 条真实关系。可使用页面上方的搜索框通过键盘查找并聚焦知识星体。`}
      </p>
      <p id={liveId} className="universe-canvas-a11y-live" aria-live="polite">
        {selectedAnnouncement}
      </p>
      <ul className="universe-canvas-a11y-list" aria-label="星图知识节点文本列表">
        {positionedNodes.map((node) => (
          <li key={node.id}>
            {TYPE_LABEL[node.type]}：{node.label}
            {node.state ? `，状态${STATE_LABEL[node.state] ?? node.state}` : "，状态未设置"}
          </li>
        ))}
      </ul>
    </div>
  );
});

UnderstandingUniverse.displayName = "UnderstandingUniverse";
