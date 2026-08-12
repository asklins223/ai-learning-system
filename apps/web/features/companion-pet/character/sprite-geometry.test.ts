import assert from "node:assert/strict";
import test from "node:test";
import {
  CHARACTER_BASE_HEIGHT,
  computeCharacterRect,
  contentSlotX,
  effectiveContentSize,
  extraWidthForScale,
  hitMaskHit,
  hitTestCharacter,
  layoutSpecForSide,
  sampleBounce,
  sampleBreath,
} from "./sprite-geometry";

test("layout foot anchors match the frozen contract", () => {
  assert.deepEqual(layoutSpecForSide("bubble-left").foot, { x: 422, y: 504 });
  assert.deepEqual(layoutSpecForSide("bubble-right").foot, { x: 138, y: 504 });
});

test("base scale character rect matches contract (1×)", () => {
  const rect = computeCharacterRect("bubble-left", 1);
  assert.equal(Math.round(rect.x), 300);
  assert.equal(Math.round(rect.y * 1000) / 1000, 216.777);
  assert.equal(rect.width, 244);
  assert.equal(Math.round(rect.height * 1000) / 1000, CHARACTER_BASE_HEIGHT);
  // foot anchor maps exactly to (422,504)
  assert.equal(Math.round(rect.x + (350 / 700) * rect.width), 422);
  assert.equal(Math.round(rect.y + (824 / 860) * rect.height), 504);
});

test("bubble-right character rect mirrors", () => {
  const rect = computeCharacterRect("bubble-right", 1);
  assert.equal(Math.round(rect.x), 16);
  assert.equal(Math.round(rect.x + (350 / 700) * rect.width), 138);
});

test("petScale keeps the foot anchor fixed and grows the window", () => {
  for (const scale of [0.85, 1.15, 1.25] as const) {
    const rect = computeCharacterRect("bubble-left", scale);
    assert.equal(Math.round(rect.x + (350 / 700) * rect.width), 422);
    assert.equal(Math.round(rect.y + (824 / 860) * rect.height), 504);
    const size = effectiveContentSize(scale);
    assert.equal(size.height, 520);
    assert.equal(size.width, 560 + extraWidthForScale(scale));
  }
  assert.equal(effectiveContentSize(1.15).width, 560 + 37);
  assert.equal(effectiveContentSize(1.25).width, 560 + 61);
  assert.equal(effectiveContentSize(0.85).width, 560);
});

test("content slot x shifts only for bubble-right under scale", () => {
  assert.equal(contentSlotX(16, "bubble-left", 1.15), 16);
  assert.equal(contentSlotX(16, "bubble-right", 1.15), 16 + 37);
  assert.equal(contentSlotX(16, "bubble-right", 1), 16);
});

function buildMask(ones: Array<[number, number]>): Uint8Array {
  const mask = new Uint8Array(128 * 128 / 8);
  for (const [x, y] of ones) {
    const byteIndex = y * 16 + Math.floor(x / 8);
    mask[byteIndex] |= 1 << (7 - (x % 8));
  }
  return mask;
}

/** Source-canvas point that lands in mask cell (cellX, cellY). */
function sourceForCell(cellX: number, cellY: number): { x: number; y: number } {
  return {
    x: ((cellX + 0.5) / 128) * 700,
    y: ((cellY + 0.5) / 128) * 860,
  };
}

test("hit mask hit/miss semantics (MSB-first, row-major)", () => {
  const mask = buildMask([[5, 5], [0, 0], [127, 127]]);
  assert.equal(hitMaskHit(mask, sourceForCell(5, 5), { width: 128, height: 128 }), true);
  assert.equal(hitMaskHit(mask, sourceForCell(0, 0), { width: 128, height: 128 }), true);
  assert.equal(hitMaskHit(mask, sourceForCell(127, 127), { width: 128, height: 128 }), true);
  assert.equal(hitMaskHit(mask, sourceForCell(20, 20), { width: 128, height: 128 }), false);
});

test("hitTestCharacter maps window points through mirror-aware source coords", () => {
  // Filled cell at source x≈175 (cell 32), y≈824 (cell 122).
  const mask = buildMask([[32, 122]]);
  const rect = computeCharacterRect("bubble-left", 1);
  const hitX = rect.x + (175 / 700) * rect.width; // source 175 → window x
  const hitY = rect.y + (824 / 860) * rect.height;
  assert.equal(
    hitTestCharacter({ x: hitX, y: hitY }, rect, false, mask, { width: 128, height: 128 }),
    true,
  );
  // Out of rect → false.
  assert.equal(
    hitTestCharacter({ x: 10, y: 10 }, rect, false, mask, { width: 128, height: 128 }),
    false,
  );
  // Mirror flips the x axis: source 175 becomes 525 → cell 96, not 32.
  assert.equal(
    hitTestCharacter({ x: hitX, y: hitY }, rect, true, mask, { width: 128, height: 128 }),
    false,
  );
});

test("breath samples are periodic and bounded", () => {
  const a = sampleBreath(0, { periodMs: 3200, maxOffsetY: 2, maxScaleY: 1.006 });
  assert.equal(Math.abs(a.offsetY), 0);
  assert.equal(a.scaleY, 1);
  const b = sampleBreath(1600, { periodMs: 3200, maxOffsetY: 2, maxScaleY: 1.006 });
  assert.ok(b.offsetY <= -1.9 && b.offsetY > -2.01);
  assert.ok(b.scaleY >= 1.005 && b.scaleY <= 1.007);
  const c = sampleBreath(3200, { periodMs: 3200, maxOffsetY: 2, maxScaleY: 1.006 });
  assert.equal(Math.abs(c.offsetY), 0);
});

test("single-shot bounce returns to zero and stays zero", () => {
  assert.equal(sampleBounce(0, 420, 6), 0);
  assert.ok(sampleBounce(210, 420, 6) < -4);
  assert.equal(sampleBounce(420, 420, 6), 0);
  assert.equal(sampleBounce(1000, 420, 6), 0);
});
