/** Shared gesture thresholds for the character click/direct-drag surface. */
export const CHARACTER_DRAG_THRESHOLD_PX = 8;
export const CHARACTER_LONG_PRESS_MS = 500;
export const CHARACTER_DOUBLE_CLICK_DEDUPE_MS = 320;

export interface GesturePointV1 {
  x: number;
  y: number;
}

export function gestureDistance(start: GesturePointV1, current: GesturePointV1): number {
  return Math.hypot(current.x - start.x, current.y - start.y);
}

export function hasCrossedCharacterDragThreshold(
  start: GesturePointV1,
  current: GesturePointV1,
): boolean {
  return gestureDistance(start, current) > CHARACTER_DRAG_THRESHOLD_PX;
}

export function canStartCharacterDrag(input: {
  start: GesturePointV1;
  current: GesturePointV1;
  locked: boolean;
}): boolean {
  return !input.locked && hasCrossedCharacterDragThreshold(input.start, input.current);
}

export function isEligibleCharacterLongPress(input: {
  pointerType: string;
  start: GesturePointV1;
  current: GesturePointV1;
  elapsedMs: number;
}): boolean {
  return (
    input.pointerType !== "mouse" &&
    input.elapsedMs >= CHARACTER_LONG_PRESS_MS &&
    !hasCrossedCharacterDragThreshold(input.start, input.current)
  );
}

export function shouldDispatchCharacterClick(input: {
  source: "character" | "handle";
  dragged: boolean;
  movedBeyondThreshold: boolean;
  longPressed: boolean;
  lastClickAt: number;
  now: number;
}): boolean {
  return (
    input.source === "character" &&
    !input.dragged &&
    !input.movedBeyondThreshold &&
    !input.longPressed &&
    input.now - input.lastClickAt > CHARACTER_DOUBLE_CLICK_DEDUPE_MS
  );
}
