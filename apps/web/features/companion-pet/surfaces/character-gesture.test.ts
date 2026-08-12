import test from "node:test";
import assert from "node:assert/strict";
import {
  CHARACTER_DRAG_THRESHOLD_PX,
  CHARACTER_LONG_PRESS_MS,
  canStartCharacterDrag,
  hasCrossedCharacterDragThreshold,
  isEligibleCharacterLongPress,
  shouldDispatchCharacterClick,
} from "./character-gesture";

test("character drag starts only after the frozen 8px threshold", () => {
  const start = { x: 10, y: 20 };
  assert.equal(
    hasCrossedCharacterDragThreshold(start, { x: 10 + CHARACTER_DRAG_THRESHOLD_PX, y: 20 }),
    false,
  );
  assert.equal(canStartCharacterDrag({ start, current: { x: 19, y: 20 }, locked: false }), true);
  assert.equal(canStartCharacterDrag({ start, current: { x: 19, y: 20 }, locked: true }), false);
});

test("touch long press opens the menu only before drag movement", () => {
  const base = {
    pointerType: "touch",
    start: { x: 0, y: 0 },
    current: { x: 4, y: 4 },
    elapsedMs: CHARACTER_LONG_PRESS_MS,
  };
  assert.equal(isEligibleCharacterLongPress(base), true);
  assert.equal(isEligibleCharacterLongPress({ ...base, pointerType: "mouse" }), false);
  assert.equal(isEligibleCharacterLongPress({ ...base, current: { x: 9, y: 0 } }), false);
});

test("drag, long press, handle and double click never dispatch a second character click", () => {
  const base = {
    source: "character" as const,
    dragged: false,
    movedBeyondThreshold: false,
    longPressed: false,
    lastClickAt: 0,
    now: 1_000,
  };
  assert.equal(shouldDispatchCharacterClick(base), true);
  assert.equal(shouldDispatchCharacterClick({ ...base, dragged: true }), false);
  assert.equal(shouldDispatchCharacterClick({ ...base, movedBeyondThreshold: true }), false);
  assert.equal(shouldDispatchCharacterClick({ ...base, longPressed: true }), false);
  assert.equal(shouldDispatchCharacterClick({ ...base, source: "handle" }), false);
  assert.equal(shouldDispatchCharacterClick({ ...base, lastClickAt: 800 }), false);
});
