import type { DesktopPetScaleV1 } from "@ailearn/shared/desktop-pet-contracts";

/**
 * Pure geometry for the Level A sprite inside the 560×520 Pet Window
 * (01 §2.2 / §2.3). All coordinates are content CSS px. The source canvas is
 * 700×860 with frozen footAnchor (350,824); the runtime canvas scales by
 * 244/700 and keeps the foot anchor fixed while petScale changes.
 */

export const PET_WINDOW_BASE_SIZE = { width: 560, height: 520 } as const;

export const SPRITE_SOURCE = {
  width: 700,
  height: 860,
  footAnchor: { x: 350, y: 824 },
} as const;

export const SPRITE_BASE_SCALE = 244 / 700;

export const CHARACTER_BASE_WIDTH = 244;

/** Runtime canvas height for the frozen source at base scale. */
export const CHARACTER_BASE_HEIGHT = Math.round(860 * SPRITE_BASE_SCALE * 1000) / 1000;

export const FOOT_Y = 504;

export type PetLayoutSide = "bubble-left" | "bubble-right";

export interface PetLayoutSpec {
  side: PetLayoutSide;
  foot: { x: number; y: number };
}

/** 01 §2.2: bubble-left → foot (422,504); bubble-right → foot (138,504). */
export function layoutSpecForSide(side: PetLayoutSide): PetLayoutSpec {
  return side === "bubble-left"
    ? { side, foot: { x: 422, y: FOOT_Y } }
    : { side, foot: { x: 138, y: FOOT_Y } };
}

/** 01 §2.3: extraWidth = ceil(244 × (max(1, petScale) − 1)). */
export function extraWidthForScale(petScale: DesktopPetScaleV1): number {
  return Math.ceil(CHARACTER_BASE_WIDTH * (Math.max(1, petScale) - 1));
}

/** Effective content size: (560 + extraWidth) × 520. */
export function effectiveContentSize(petScale: DesktopPetScaleV1): {
  width: number;
  height: number;
} {
  return {
    width: PET_WINDOW_BASE_SIZE.width + extraWidthForScale(petScale),
    height: PET_WINDOW_BASE_SIZE.height,
  };
}

export interface CharacterRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Character canvas rect for a given side and scale. The canvas scales around
 * the frozen source foot anchor; bubble-left base rect is
 * (300, 216.777, 244, 299.771), bubble-right mirrors x=16.
 */
export function computeCharacterRect(
  side: PetLayoutSide,
  petScale: DesktopPetScaleV1,
): CharacterRect {
  const spec = layoutSpecForSide(side);
  const width = CHARACTER_BASE_WIDTH * petScale;
  const height = CHARACTER_BASE_HEIGHT * petScale;
  const x = spec.foot.x - SPRITE_SOURCE.footAnchor.x * SPRITE_BASE_SCALE * petScale;
  const y = spec.foot.y - SPRITE_SOURCE.footAnchor.y * SPRITE_BASE_SCALE * petScale;
  return { x, y, width, height };
}

/**
 * Horizontal shift applied to the character/menu-trigger/drag-handle slot when
 * petScale > 1 (01 §2.3): bubble-left adds ceil(extra/2), bubble-right adds
 * floor(extra/2).
 */
export function characterSlotShift(
  side: PetLayoutSide,
  petScale: DesktopPetScaleV1,
): number {
  const extra = extraWidthForScale(petScale);
  if (side === "bubble-left") return Math.ceil(extra / 2);
  return Math.floor(extra / 2);
}

/**
 * Bubble/composer/menu base x under scale: bubble-left keeps its x, bubble-right
 * shifts by the full extra width (01 §2.3).
 */
export function contentSlotX(
  baseX: number,
  side: PetLayoutSide,
  petScale: DesktopPetScaleV1,
): number {
  if (side === "bubble-left") return baseX;
  return baseX + extraWidthForScale(petScale);
}

/**
 * Point → source canvas coordinate (mirror-aware). Returns null when the point
 * is outside the character rect.
 */
export function sourceCoordinateForPoint(
  point: { x: number; y: number },
  rect: CharacterRect,
  mirror: boolean,
): { x: number; y: number } | null {
  if (
    point.x < rect.x ||
    point.x >= rect.x + rect.width ||
    point.y < rect.y ||
    point.y >= rect.y + rect.height
  ) {
    return null;
  }
  let sx = ((point.x - rect.x) / rect.width) * SPRITE_SOURCE.width;
  const sy = ((point.y - rect.y) / rect.height) * SPRITE_SOURCE.height;
  if (mirror) sx = SPRITE_SOURCE.width - sx;
  return { x: sx, y: sy };
}

/**
 * Hit test against a 128×128 MSB-first row-major bit mask (2048 bytes).
 * A mask pixel is 1 when any source pixel in its region has alpha >= 32.
 */
export function hitMaskHit(
  mask: Uint8Array,
  sourcePoint: { x: number; y: number },
  maskSize: { width: number; height: number },
): boolean {
  const mw = maskSize.width;
  const mh = maskSize.height;
  const mx = Math.min(
    mw - 1,
    Math.max(0, Math.floor((sourcePoint.x / SPRITE_SOURCE.width) * mw)),
  );
  const my = Math.min(
    mh - 1,
    Math.max(0, Math.floor((sourcePoint.y / SPRITE_SOURCE.height) * mh)),
  );
  const byteIndex = my * Math.ceil(mw / 8) + Math.floor(mx / 8);
  const bit = 7 - (mx % 8);
  if (byteIndex >= mask.length) return false;
  return ((mask[byteIndex] >> bit) & 1) === 1;
}

/** Convenience: window-content point → hit decision for the current pose. */
export function hitTestCharacter(
  point: { x: number; y: number },
  rect: CharacterRect,
  mirror: boolean,
  mask: Uint8Array,
  maskSize: { width: number; height: number },
): boolean {
  const source = sourceCoordinateForPoint(point, rect, mirror);
  if (!source) return false;
  return hitMaskHit(mask, source, maskSize);
}

// ─── Level A motion timing (01 §4.2) ───────────────────────────────────

export interface BreathSpec {
  periodMs: number;
  maxOffsetY: number; // px, upward
  maxScaleY: number; // 1..1.006
}

export const BREATH_SPECS = {
  idle: { periodMs: 3200, maxOffsetY: 2, maxScaleY: 1.006 },
  listening: { periodMs: 1800, maxOffsetY: 1, maxScaleY: 1.01 },
  speaking: { periodMs: 1200, maxOffsetY: 1, maxScaleY: 1.004 },
} as const satisfies Record<string, BreathSpec>;

export interface BreathSample {
  offsetY: number;
  scaleY: number;
}

/** Smooth 0..1..0 breath over the period (sine), sampled at absolute t. */
export function sampleBreath(tMs: number, spec: BreathSpec): BreathSample {
  const phase = (tMs % spec.periodMs) / spec.periodMs;
  const wave = (1 - Math.cos(phase * Math.PI * 2)) / 2; // 0..1..0
  return {
    offsetY: -spec.maxOffsetY * wave,
    scaleY: 1 + (spec.maxScaleY - 1) * wave,
  };
}

export const INCOMING_BOUNCE_MS = 420;
export const CELEBRATE_BOUNCE_MS = 420;

/** Single-shot bounce: 0 → -height → 0 with ease-in-out. Returns 0 after done. */
export function sampleBounce(
  elapsedMs: number,
  durationMs: number,
  heightPx: number,
): number {
  if (elapsedMs >= durationMs) return 0;
  const t = elapsedMs / durationMs;
  const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  const value = -heightPx * Math.sin(eased * Math.PI);
  return value === 0 ? 0 : value;
}
