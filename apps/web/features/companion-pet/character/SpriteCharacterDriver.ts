"use client";

import {
  SPRITE_POSE_BY_PRESENTATION,
  type CharacterPresentationStateV1,
  type SpritePoseV1,
} from "@ailearn/shared";
import type { DesktopPetScaleV1 } from "@ailearn/shared";
import { sha256Hex, type SpriteAssetPackV1 } from "./sprite-asset-validator";
import {
  BREATH_SPECS,
  CELEBRATE_BOUNCE_MS,
  INCOMING_BOUNCE_MS,
  computeCharacterRect,
  hitTestCharacter,
  layoutSpecForSide,
  sampleBounce,
  sampleBreath,
  type CharacterRect,
} from "./sprite-geometry";

/**
 * Level A Sprite driver (01 §7.4 / §4.2). Renders the frozen 700×860 poses
 * onto a canvas with the fixed foot anchor, applies the lightweight breath /
 * bounce rules, and answers character hit tests from the pose's own alpha
 * mask. Reduced motion / animationOff switch to a static frame; hidden clears
 * the canvas and stops the ticker.
 */

export interface SpriteLayoutV1 {
  side: "bubble-left" | "bubble-right";
  petScale: DesktopPetScaleV1;
  /** true when the character faces the bubble (mirrored from source). */
  mirror: boolean;
  reducedMotion: boolean;
  animationOff: boolean;
  devicePixelRatio?: number;
}

export interface SpriteDriverOptionsV1 {
  canvas: HTMLCanvasElement;
  pack: SpriteAssetPackV1;
}

export interface SpriteHitMaskV1 {
  width: number;
  height: number;
  bitsBase64: string;
  sha256: string;
}

export class SpriteCharacterDriver {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly pack: SpriteAssetPackV1;
  private readonly images = new Map<SpritePoseV1, HTMLImageElement>();
  private readonly mirroredMaskHashes = new Map<string, string>();
  private readonly hitMaskCache = new Map<string, { bitsBase64: string; sha256: string }>();
  private readonly objectUrls: string[] = [];

  private presentation: CharacterPresentationStateV1 = "idle";
  private layout: SpriteLayoutV1 = {
    side: "bubble-left",
    petScale: 1,
    mirror: true,
    reducedMotion: false,
    animationOff: false,
    devicePixelRatio: 1,
  };

  private rafId: number | null = null;
  private running = false;
  private lastFrameAt = 0;
  private incomingStartedAt: number | null = null;
  private celebrateStartedAt: number | null = null;

  constructor(options: SpriteDriverOptionsV1) {
    this.canvas = options.canvas;
    this.pack = options.pack;
    const ctx = this.canvas.getContext("2d");
    if (!ctx) {
      throw new Error("SpriteCharacterDriver: 2d context unavailable");
    }
    this.ctx = ctx;
  }

  /** Preloads all eight poses as images. Must be awaited before first draw. */
  async init(): Promise<void> {
    const { manifest } = this.pack;
    await Promise.all(
      manifest.poseOrder.map(async (pose) => {
        const entry = manifest.poses[pose];
        if (!entry) throw new Error(`missing pose entry: ${pose}`);
        const blob = new Blob([this.pack.images[entry.image]], {
          type: "image/png",
        });
        const url = URL.createObjectURL(blob);
        this.objectUrls.push(url);
        const image = new Image();
        image.src = url;
        await image.decode();
        this.images.set(pose, image);
      }),
    );
    await Promise.all(
      manifest.poseOrder.map(async (pose) => {
        const entry = manifest.poses[pose];
        if (!entry) throw new Error(`missing pose entry: ${pose}`);
        const mirrored = mirrorMask(
          new Uint8Array(this.pack.hitMasks[entry.hitMask]),
          entry.hitMaskSize.width,
          entry.hitMaskSize.height,
        );
        this.mirroredMaskHashes.set(entry.hitMask, await sha256Hex(mirrored));
      }),
    );
  }

  setPresentation(presentation: CharacterPresentationStateV1, now = performance.now()): void {
    const changed = presentation !== this.presentation;
    this.presentation = presentation;
    if (changed) {
      if (presentation === "invite") {
        this.incomingStartedAt = now;
      } else {
        this.incomingStartedAt = null;
      }
      if (presentation === "celebrate") {
        this.celebrateStartedAt = now;
      } else {
        this.celebrateStartedAt = null;
      }
      if (!this.shouldAnimate()) {
        this.renderFrame(now);
      }
    }
  }

  setLayout(layout: Partial<SpriteLayoutV1>): void {
    this.layout = { ...this.layout, ...layout };
    this.renderFrame(performance.now());
  }

  /** Window-content point → whether it hits the current pose alpha mask. */
  hitTest(point: { x: number; y: number }): boolean {
    const pose = SPRITE_POSE_BY_PRESENTATION[this.presentation];
    if (!pose) return false;
    const entry = this.pack.manifest.poses[pose];
    if (!entry) return false;
    const rect = computeCharacterRect(this.layout.side, this.layout.petScale);
    const mask = this.pack.hitMasks[entry.hitMask];
    // mask 为 ArrayBuffer——new Uint8Array(mask) 创建零拷贝视图（非拷贝），
    // hitMaskHit 只读；保留视图创建以满足类型签名。
    return hitTestCharacter(
      point,
      rect,
      this.layout.mirror,
      new Uint8Array(mask),
      entry.hitMaskSize,
    );
  }

  /**
   * Returns the current pose mask in the same MSB-first format as the frozen
   * sprite assets. The desktop main process uses this to avoid registering a
   * transparent bounding box as an interactive character region.
   */
  getCurrentHitMask(): SpriteHitMaskV1 | null {
    const pose = SPRITE_POSE_BY_PRESENTATION[this.presentation];
    const entry = pose ? this.pack.manifest.poses[pose] : undefined;
    if (!entry) return null;
    // M8（审计修复）：镜像 + base64 是 O(mask bytes) 全量计算，而
    // registerGeometry 会随 drag/bubble/composer/menu 状态变化反复触发
    // getCurrentHitMask——同一 pose 缓存结果（key = mask id + mirror），
    // 避免每帧重建（70KB 位图 × 每轮交互多次）。
    const cacheKey = `${entry.hitMask}:${this.layout.mirror ? "mirror" : "source"}`;
    const cached = this.hitMaskCache.get(cacheKey);
    if (cached) {
      return { width: entry.hitMaskSize.width, height: entry.hitMaskSize.height, ...cached };
    }
    const source = new Uint8Array(this.pack.hitMasks[entry.hitMask]);
    const bytes = this.layout.mirror
      ? mirrorMask(source, entry.hitMaskSize.width, entry.hitMaskSize.height)
      : source;
    const value = {
      bitsBase64: bytesToBase64(bytes),
      sha256: this.layout.mirror
        ? this.mirroredMaskHashes.get(entry.hitMask) ?? entry.hitMaskSha256
        : entry.hitMaskSha256,
    };
    this.hitMaskCache.set(cacheKey, value);
    return { width: entry.hitMaskSize.width, height: entry.hitMaskSize.height, ...value };
  }

  pause(): void {
    this.running = false;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  resume(now = performance.now()): void {
    this.running = true;
    this.lastFrameAt = now;
    if (this.rafId === null) {
      this.rafId = requestAnimationFrame(this.tick);
    }
  }

  destroy(): void {
    this.pause();
    for (const url of this.objectUrls) {
      URL.revokeObjectURL(url);
    }
    this.objectUrls.length = 0;
    this.images.clear();
    this.mirroredMaskHashes.clear();
    this.hitMaskCache.clear();
  }

  private shouldAnimate(): boolean {
    if (this.layout.reducedMotion || this.layout.animationOff) return false;
    if (this.presentation === "hidden") return false;
    if (this.presentation === "invite" && this.incomingStartedAt !== null) return true;
    if (this.presentation === "celebrate" && this.celebrateStartedAt !== null) return true;
    return (
      this.presentation === "idle" ||
      this.presentation === "listen" ||
      this.presentation === "speak"
    );
  }

  private tick = (now: number): void => {
    if (!this.running) return;
    const dt = now - this.lastFrameAt;
    // 2026-08-11（性能专项）：idle 呼吸动画降帧到 30fps（慢速动画视觉无差，
    // CPU/GPU 开销减半）；listen/speak/invite/celebrate 保持 60fps。
    if (this.presentation === "idle" && dt < 1000 / 30) {
      this.rafId = requestAnimationFrame(this.tick);
      return;
    }
    this.lastFrameAt = now;
    if (dt < 0) {
      // Clock jump (sleep/resume): re-baseline single-shot timers.
      this.incomingStartedAt = null;
      this.celebrateStartedAt = null;
    }
    this.renderFrame(now);
    if (this.shouldAnimate()) {
      this.rafId = requestAnimationFrame(this.tick);
    } else {
      this.rafId = null;
    }
  };

  private renderFrame(now: number): void {
    const pose = SPRITE_POSE_BY_PRESENTATION[this.presentation];
    const dpr = this.layout.devicePixelRatio ?? 1;
    const rect = computeCharacterRect(this.layout.side, this.layout.petScale);
    const cssWidth = rect.width;
    const cssHeight = rect.height;
    if (this.canvas.width !== Math.round(cssWidth * dpr) || this.canvas.height !== Math.round(cssHeight * dpr)) {
      this.canvas.width = Math.round(cssWidth * dpr);
      this.canvas.height = Math.round(cssHeight * dpr);
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ctx.clearRect(0, 0, cssWidth, cssHeight);
    if (!pose || this.presentation === "hidden") return;
    const image = this.images.get(pose);
    if (!image) return;

    let offsetY = 0;
    let scaleY = 1;
    if (!this.layout.reducedMotion && !this.layout.animationOff) {
      if (this.presentation === "idle") {
        const breath = sampleBreath(now, BREATH_SPECS.idle);
        offsetY = breath.offsetY;
        scaleY = breath.scaleY;
      } else if (this.presentation === "listen") {
        const breath = sampleBreath(now, BREATH_SPECS.listening);
        offsetY = breath.offsetY;
        scaleY = breath.scaleY;
      } else if (this.presentation === "speak") {
        const breath = sampleBreath(now, BREATH_SPECS.speaking);
        offsetY = breath.offsetY;
        scaleY = breath.scaleY;
      }
      if (this.incomingStartedAt !== null) {
        offsetY += sampleBounce(now - this.incomingStartedAt, INCOMING_BOUNCE_MS, 5);
      }
      if (this.celebrateStartedAt !== null) {
        offsetY += sampleBounce(now - this.celebrateStartedAt, CELEBRATE_BOUNCE_MS, 6);
      }
    }

    // The canvas element is positioned at the character rect by the surface,
    // so all drawing uses canvas-local coordinates (foot anchor relative to
    // the rect origin). Content-space geometry (hit tests, window layout)
    // stays untouched.
    const foot = layoutSpecForSide(this.layout.side).foot;
    const localFoot = { x: foot.x - rect.x, y: foot.y - rect.y };
    this.ctx.save();
    this.ctx.translate(localFoot.x, localFoot.y + offsetY);
    this.ctx.scale(1, scaleY);
    this.ctx.translate(-localFoot.x, -localFoot.y);
    if (this.layout.mirror) {
      // Horizontal flip about the canvas center: scale first, then translate
      // so x' = cssWidth - x stays inside the canvas.
      this.ctx.scale(-1, 1);
      this.ctx.translate(-cssWidth, 0);
    }
    this.ctx.drawImage(image, 0, 0, cssWidth, cssHeight);
    this.ctx.restore();
  }

  get currentPresentation(): CharacterPresentationStateV1 {
    return this.presentation;
  }

  get currentRect(): CharacterRect {
    return computeCharacterRect(this.layout.side, this.layout.petScale);
  }
}

function mirrorMask(source: Uint8Array, width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(source.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sourceBit = y * width + x;
      if ((source[Math.floor(sourceBit / 8)] & (1 << (7 - (sourceBit % 8)))) === 0) continue;
      const targetBit = y * width + (width - 1 - x);
      bytes[Math.floor(targetBit / 8)] |= 1 << (7 - (targetBit % 8));
    }
  }
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}
