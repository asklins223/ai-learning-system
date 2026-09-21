import type {
  CompanionHomeZone,
  CompanionNormalizedAnchor,
  CompanionPosition,
} from "../../app/room-store";

type Size = { readonly width: number; readonly height: number };
export type Point = { readonly x: number; readonly y: number };
export type Rect = { readonly left: number; readonly right: number; readonly top: number; readonly bottom: number };
export type CompanionTranslationBounds = {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
};

export type CompanionTouchKind = "head" | "body";
export type CompanionMotionMode = "full" | "lite" | "off";
export type CompanionDragEndType = "pointerup" | "pointercancel" | "lostpointercapture";

/**
 * Normalized floor anchors in the lighthouse study. Values describe the
 * character's foot point, so resizing the Live2D surface does not move its
 * relationship to furniture.
 */
export const COMPANION_HOME_ANCHORS: Readonly<Record<CompanionHomeZone, Point>> = Object.freeze({
  shelf: { x: 0.72, y: 0.62 },
  desk: { x: 0.34, y: 0.62 },
  window: { x: 0.52, y: 0.55 },
  rest: { x: 0.75, y: 0.72 },
});

/**
 * Converts a room-space foot anchor through the already transformed camera
 * rectangle. Reading the browser's camera bounds keeps this projection exactly
 * aligned with CSS transform order, transform origin and fractional pixels.
 */
export function companionProjectedFootPoint(
  anchor: CompanionNormalizedAnchor,
  projectedWorld: Rect,
): Point {
  return {
    x: projectedWorld.left + (projectedWorld.right - projectedWorld.left) * clamp(anchor.x, 0, 1),
    y: projectedWorld.top + (projectedWorld.bottom - projectedWorld.top) * clamp(anchor.y, 0, 1),
  };
}

/** Position an unscaled anchor box in an overlay root from a room-space foot. */
export function companionPositionForProjectedFootAnchor(
  worldAnchor: CompanionNormalizedAnchor,
  projectedWorld: Rect,
  overlayRoot: Rect,
  companion: Size,
): CompanionPosition {
  const foot = companionProjectedFootPoint(worldAnchor, projectedWorld);
  return {
    x: foot.x - overlayRoot.left - companion.width / 2,
    y: foot.y - overlayRoot.top - companion.height,
  };
}

/**
 * Inverse of `companionProjectedFootPoint`, used at pointer release. The
 * character's bottom-centre is its ground contact, so arbitrary drops survive
 * later camera moves without snapping to a named zone.
 */
export function companionWorldAnchorFromProjectedFoot(
  foot: Point,
  projectedWorld: Rect,
): CompanionNormalizedAnchor {
  const width = projectedWorld.right - projectedWorld.left;
  const height = projectedWorld.bottom - projectedWorld.top;
  if (width <= 0 || height <= 0) return { x: 0.5, y: 0.5 };
  return {
    x: clamp((foot.x - projectedWorld.left) / width, 0, 1),
    y: clamp((foot.y - projectedWorld.top) / height, 0, 1),
  };
}

const HOME_ZONES = Object.freeze(Object.keys(COMPANION_HOME_ANCHORS) as CompanionHomeZone[]);

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function pointInPolygon(point: Point, polygon: readonly (readonly [number, number])[]): boolean {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const [x, y] = polygon[index];
    const [previousX, previousY] = polygon[previous];
    if ((y > point.y) !== (previousY > point.y)) {
      const edgeX = ((previousX - x) * (point.y - y)) / (previousY - y) + x;
      if (point.x < edgeX) inside = !inside;
    }
  }
  return inside;
}

function closestPointOnSegment(point: Point, start: Point, end: Point): Point {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= Number.EPSILON) return start;
  const t = clamp(((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared, 0, 1);
  return { x: start.x + dx * t, y: start.y + dy * t };
}

/** Clamp a normalized Live2D foot point to the closest point on a legal floor polygon. */
export function clampCompanionAnchorToPolygon(
  anchor: CompanionNormalizedAnchor,
  polygon: readonly (readonly [number, number])[],
): CompanionNormalizedAnchor {
  const point = { x: clamp(anchor.x, 0, 1), y: clamp(anchor.y, 0, 1) };
  if (polygon.length < 3 || pointInPolygon(point, polygon)) return point;
  let closest = point;
  let closestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < polygon.length; index += 1) {
    const [startX, startY] = polygon[index];
    const [endX, endY] = polygon[(index + 1) % polygon.length];
    const candidate = closestPointOnSegment(point, { x: startX, y: startY }, { x: endX, y: endY });
    const distance = (candidate.x - point.x) ** 2 + (candidate.y - point.y) ** 2;
    if (distance < closestDistance) {
      closest = candidate;
      closestDistance = distance;
    }
  }
  return { x: clamp(closest.x, 0, 1), y: clamp(closest.y, 0, 1) };
}

export function companionSafeInset(frame: Size): number {
  return Math.round(clamp(Math.min(frame.width, frame.height) * 0.025, 6, 14));
}

function axisCorrection(start: number, end: number, safeStart: number, safeEnd: number): number {
  const size = end - start;
  const available = safeEnd - safeStart;
  if (size > available) {
    return (safeStart + safeEnd) / 2 - (start + end) / 2;
  }
  if (start < safeStart) return safeStart - start;
  if (end > safeEnd) return safeEnd - end;
  return 0;
}

export function companionViewportCorrection(
  frame: Rect,
  companion: Rect,
  safe = companionSafeInset({ width: frame.right - frame.left, height: frame.bottom - frame.top }),
): CompanionPosition {
  return {
    x: axisCorrection(companion.left, companion.right, frame.left + safe, frame.right - safe),
    y: axisCorrection(companion.top, companion.bottom, frame.top + safe, frame.bottom - safe),
  };
}

export function companionNormalizedFootAnchor(
  frame: Rect,
  companion: Rect,
): CompanionNormalizedAnchor {
  const width = frame.right - frame.left;
  const height = frame.bottom - frame.top;
  if (width <= 0 || height <= 0) return { x: 0.5, y: 0.5 };
  return {
    x: clamp(((companion.left + companion.right) / 2 - frame.left) / width, 0, 1),
    y: clamp((companion.bottom - frame.top) / height, 0, 1),
  };
}

export function companionPositionForNormalizedFootAnchor(
  anchor: CompanionNormalizedAnchor,
  frame: Size,
  companion: Size,
): CompanionPosition {
  return {
    x: frame.width * clamp(anchor.x, 0, 1) - companion.width / 2,
    y: frame.height * clamp(anchor.y, 0, 1) - companion.height,
  };
}

export function companionTranslationBounds(
  position: CompanionPosition,
  frame: Rect,
  companion: Rect,
  safe = companionSafeInset({ width: frame.right - frame.left, height: frame.bottom - frame.top }),
): CompanionTranslationBounds {
  let minX = position.x + frame.left + safe - companion.left;
  let maxX = position.x + frame.right - safe - companion.right;
  let minY = position.y + frame.top + safe - companion.top;
  let maxY = position.y + frame.bottom - safe - companion.bottom;

  if (minX > maxX) minX = maxX = position.x + (frame.left + frame.right - companion.left - companion.right) / 2;
  if (minY > maxY) minY = maxY = position.y + (frame.top + frame.bottom - companion.top - companion.bottom) / 2;
  return { minX, maxX, minY, maxY };
}

export function companionPositionForHomeZone(
  zone: CompanionHomeZone,
  frame: Size,
  companion: Size,
  safe = 6,
): CompanionPosition {
  const anchor = COMPANION_HOME_ANCHORS[zone];
  return {
    x: Math.round(clamp(
      frame.width * anchor.x - companion.width / 2,
      safe,
      Math.max(safe, frame.width - companion.width - safe),
    )),
    y: Math.round(clamp(
      frame.height * anchor.y - companion.height,
      safe,
      Math.max(safe, frame.height - companion.height - safe),
    )),
  };
}

/**
 * The directory rail is a floating column at the window's left edge: a 22px
 * margin plus a 58px island. A left-seat page measures its inset from the far
 * side of that column, so both seats end up the same visual distance from the
 * chrome that owns their gutter. Must stay in sync with the `comp-left` block
 * in `styles.css`, which covers the frame before the companion runtime mounts.
 */
export const COMPANION_RAIL_GUTTER = 80;

/**
 * Fixed per-page seat for task surfaces, from the approved desktop-pages-v3
 * registry (`HUD_PAGES[*].seat`). Task pages use a fixed on-demand seat: its side
 * is decided by the page registry, never by the user, so the position is a
 * pure function of the viewport and the anchor box. One inset per axis shared
 * by both seats — the anchor hugs whichever chrome owns its gutter and stops
 * at the same distance from the window's bottom on both sides.
 */
export function companionSeatTarget(
  seat: "left" | "right",
  frame: Size,
  companion: Size,
  railGutter: number = COMPANION_RAIL_GUTTER,
): CompanionPosition {
  const edgeInset = Math.min(22, Math.max(12, frame.width * 0.015));
  const bottomInset = Math.min(16, Math.max(8, frame.height * 0.015));
  return {
    x: seat === "left"
      ? railGutter + edgeInset
      : frame.width - companion.width - edgeInset,
    y: frame.height - companion.height - bottomInset,
  };
}

/**
 * Semantic-zone moves can cross most of the room. A fixed 480 ms duration
 * makes those long paths read as teleportation, while a slow short nudge feels
 * sticky. Scale only the user-visible travel window, with hard bounds so cues
 * stay responsive and reduced motion remains immediate.
 */
export function companionSemanticTravelDuration(
  distance: number,
  mode: CompanionMotionMode,
): number {
  if (mode === "off" || !Number.isFinite(distance) || distance <= 0.5) return 0;
  const fullDuration = clamp(0.4 + distance / 1_650, 0.42, 0.86);
  return mode === "lite" ? clamp(fullDuration * 0.46, 0.2, 0.34) : fullDuration;
}

/**
 * Pointer capture can outlive the physical press when a window is hidden,
 * blurred, or its renderer is reconfigured. Only movement that still carries
 * the primary-button bit belongs to the active direct-manipulation gesture.
 */
export function companionPointerHasPrimaryContact(buttons: number): boolean {
  return Number.isFinite(buttons) && (buttons & 1) === 1;
}

/**
 * A canceled/lost capture is an interruption, never a user placement commit.
 * Requiring a real primary-contact move also prevents a stale pointer record
 * from becoming a drag when the mouse later moves with every button released.
 */
export function shouldCommitCompanionDrag(
  eventType: CompanionDragEndType,
  activated: boolean,
  movedWithPrimaryContact: boolean,
): boolean {
  return eventType === "pointerup" && activated && movedWithPrimaryContact;
}

export function companionTouchKindAt(clientY: number, top: number, height: number): CompanionTouchKind {
  if (height <= 0) return "body";
  return (clientY - top) / height < 0.42 ? "head" : "body";
}

export function pointFallsWithinExpandedRect(point: Point, rect: Rect, margin = 0): boolean {
  return point.x >= rect.left - margin
    && point.x <= rect.right + margin
    && point.y >= rect.top - margin
    && point.y <= rect.bottom + margin;
}

export type CompanionCuePriority =
  | "ordinary"
  | "due-review"
  | "active-learning"
  | "interrupted-task"
  | "sync-error";

const CUE_RANK: Readonly<Record<CompanionCuePriority, number>> = Object.freeze({
  ordinary: 1,
  "due-review": 2,
  "active-learning": 3,
  "interrupted-task": 4,
  "sync-error": 5,
});

export function companionCueRank(priority: CompanionCuePriority): number {
  return CUE_RANK[priority];
}

/** 主动气泡是谁：与投影合同 `proactiveCue.origin` 同一套。 */
export type CompanionCueOrigin = "thought" | "reminder" | "system";

/**
 * 例行气泡的**显示去抖**，不是频率策略。
 *
 * "她多久主动说一次"归服务端（`PROACTIVE_CADENCE_MS(intervention_level)`）。
 * 这一层只剩一件事：投影会在一次揭示节拍里刷新好几回，别把同一次开口叠成两个气泡。
 *
 * 原来这里按人格写了第二套节奏，而且 `quiet: null` = **永不**——比服务端更狠：
 * 用户设成"安静"之后，哪怕服务端放行了一条，客户端也会把它无声吞掉
 * （抱怨 #8"完全没感知到主动提醒"的另一半）。两套定义同一个"安静"，
 * 就永远没人能说出她到底会不会开口。
 */
export const COMPANION_ORDINARY_CUE_DEBOUNCE_MS = 90_000;

/**
 * 这条气泡现在能不能显示。触发式（用户先要过的到点提醒、他正在等的系统事件）
 * 永远能——那是闹钟，不是闲聊，不该被任何去抖压住。
 */
export function companionCueAllowed(input: {
  readonly origin: CompanionCueOrigin;
  readonly priority: CompanionCuePriority;
  readonly lastOrdinaryCueAt: number;
  readonly now: number;
}): boolean {
  if (input.priority !== "ordinary") return true;
  if (input.origin !== "thought") return true;
  const last = Number.isFinite(input.lastOrdinaryCueAt) ? input.lastOrdinaryCueAt : 0;
  return input.now - last >= COMPANION_ORDINARY_CUE_DEBOUNCE_MS;
}

/**
 * A position the user chose by hand is theirs. Reminders may change expression
 * and show a bubble, but may never borrow or replace the world anchor: even a
 * temporary detour reads as a hidden magnet during direct manipulation.
 */
export function shouldCompanionBorrowPlacement(input: {
  readonly priority: CompanionCuePriority;
  readonly placementOwner: "semantic" | "user";
  readonly dragging: boolean;
}): boolean {
  void input;
  return false;
}
