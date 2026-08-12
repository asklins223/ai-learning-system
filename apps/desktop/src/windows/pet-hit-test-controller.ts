import { createHash } from "node:crypto";
import {
  petHitGeometryV1Schema,
  type DesktopPetInteractionModeV1,
  type PetHitGeometryV1,
} from "@ailearn/shared";

export interface PointV1 { x: number; y: number }
export interface BoundsV1 { x: number; y: number; width: number; height: number }

export function contentPointFromScreenPoint(point: PointV1, bounds: BoundsV1): PointV1 {
  return { x: point.x - bounds.x, y: point.y - bounds.y };
}

export function pointInRect(point: PointV1, rect: { x: number; y: number; width: number; height: number }): boolean {
  return point.x >= rect.x && point.x <= rect.x + rect.width
    && point.y >= rect.y && point.y <= rect.y + rect.height;
}

export function pointInPolygon(point: PointV1, polygon: PointV1[]): boolean {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const currentPoint = polygon[index];
    const previousPoint = polygon[previous];
    const intersects = (currentPoint.y > point.y) !== (previousPoint.y > point.y)
      && point.x < ((previousPoint.x - currentPoint.x) * (point.y - currentPoint.y))
        / (previousPoint.y - currentPoint.y) + currentPoint.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

type AlphaMaskCacheV1 = Map<string, Buffer | null>;

export function pointHitsGeometry(
  point: PointV1,
  geometry: PetHitGeometryV1,
  alphaMaskCache?: AlphaMaskCacheV1,
): boolean {
  for (const region of geometry.regions) {
    if (!pointInRect(point, region.rect)) continue;
    if (region.kind === "rect") return true;
    if (region.kind === "polygon" && region.polygon && pointInPolygon(point, region.polygon)) return true;
    if (region.kind === "alpha_mask" && region.mask && pointInAlphaMask(point, region.rect, region.mask, alphaMaskCache)) return true;
  }
  return false;
}

function pointInAlphaMask(
  point: PointV1,
  rect: { x: number; y: number; width: number; height: number },
  mask: { width: number; height: number; bitsBase64: string; sha256: string },
  cache?: AlphaMaskCacheV1,
): boolean {
  const cacheKey = `${mask.sha256}:${mask.bitsBase64.length}`;
  let bits = cache?.get(cacheKey);
  if (bits === undefined) {
    const decoded = Buffer.from(mask.bitsBase64, "base64");
    bits = createHash("sha256").update(decoded).digest("hex") === mask.sha256 ? decoded : null;
    cache?.set(cacheKey, bits);
  }
  if (!bits) return false;
  const x = Math.min(mask.width - 1, Math.max(0, Math.floor(((point.x - rect.x) / rect.width) * mask.width)));
  const y = Math.min(mask.height - 1, Math.max(0, Math.floor(((point.y - rect.y) / rect.height) * mask.height)));
  const bitIndex = y * mask.width + x;
  const byteIndex = Math.floor(bitIndex / 8);
  // Sprite masks are frozen as MSB-first row-major bitmaps. Keep the native
  // hit tester in the same format as the browser renderer.
  return byteIndex < bits.length && (bits[byteIndex] & (1 << (7 - (bitIndex % 8)))) !== 0;
}

export interface HitTestWindow {
  isDestroyed(): boolean;
  isVisible(): boolean;
  getContentBounds(): BoundsV1;
  setIgnoreMouseEvents(ignore: boolean, options?: { forward: boolean }): void;
}

export class PetHitTestController {
  private geometry: PetHitGeometryV1 | null = null;
  private interactionMode: DesktopPetInteractionModeV1 = "passive";
  private ignored: boolean | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly alphaMaskCache: AlphaMaskCacheV1 = new Map();
  // 2026-08-11（性能专项）：上次光标位置——静止光标跳过命中计算
  private lastCursor: PointV1 = { x: Number.NaN, y: Number.NaN };

  constructor(
    private readonly window: HitTestWindow,
    private readonly getCursorScreenPoint: () => PointV1,
    private readonly options: { forward?: boolean } = {},
  ) {}

  /** Current native mouse pass-through state for the P6 soak sampler. */
  get isClickThrough(): boolean {
    return this.ignored === true;
  }

  registerGeometry(input: PetHitGeometryV1): void {
    const geometry = petHitGeometryV1Schema.parse(input);
    // §9.1：所有 region 坐标必须在 content bounds 内。异常/恶意 renderer 若
    // 注册覆盖全屏的 rect 会让点击穿透永久失效——拒绝整批几何并保留上一
    // 次有效几何（fail-closed）。
    // M1（审计修复）：bounds 校验只保证"在 content 内"，无法阻止被攻破的
    // renderer 注册覆盖几乎整个窗口的 rect（0,0,560×520 合法）把窗口变成
    // 全屏点击拦截器。加总面积上限：单 region bbox ≤ content 的 80%、
    // 全部 region bbox 面积和 ≤ content 的 90%；超限拒绝整批。
    const contentArea = geometry.contentWidth * geometry.contentHeight;
    let totalBboxArea = 0;
    for (const region of geometry.regions) {
      const { x, y, width, height } = region.rect;
      if (x < 0 || y < 0 || x + width > geometry.contentWidth || y + height > geometry.contentHeight) {
        return;
      }
      for (const p of region.polygon ?? []) {
        if (p.x < 0 || p.y < 0 || p.x > geometry.contentWidth || p.y > geometry.contentHeight) {
          return;
        }
      }
      const bboxArea = width * height;
      if (bboxArea > contentArea * 0.8) return;
      totalBboxArea += bboxArea;
    }
    if (totalBboxArea > contentArea * 0.9) return;
    if (this.geometry && geometry.revision <= this.geometry.revision) return;
    this.geometry = geometry;
    this.alphaMaskCache.clear();
  }

  /**
   * §11：renderer reload/crash 后组件内存里的 revision 从 1 重新计数，
   * 永远 ≤ 旧值，registerGeometry 会永久拒绝新几何。主进程必须在
   * did-navigate / render-process-gone 时清空几何，让新页面重新注册。
   */
  resetGeometry(): void {
    this.geometry = null;
    this.alphaMaskCache.clear();
    this.tick();
  }

  setInteractionMode(mode: DesktopPetInteractionModeV1): void {
    this.interactionMode = mode;
    // 2026-08-11：模式切换后强制重算（即使光标未移动）——text_input 等
    // 强制交互模式必须立即生效，不能被光标去重跳过。
    this.lastCursor = { x: Number.NaN, y: Number.NaN };
    this.tick();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 33);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  tick(): void {
    if (this.window.isDestroyed() || !this.window.isVisible()) return;
    // 2026-08-11（性能专项）：光标未移动时跳过命中计算（33ms 轮询大部分
    // tick 是静止光标——pointHitsGeometry 含 alpha mask 遍历与 DPR 换算）。
    const cursor = this.getCursorScreenPoint();
    if (cursor.x === this.lastCursor.x && cursor.y === this.lastCursor.y) return;
    this.lastCursor = cursor;
    const forcedInteractive = this.interactionMode !== "passive";
    const shouldIgnore = !forcedInteractive && (!this.geometry || !pointHitsGeometry(
      contentPointFromScreenPoint(cursor, this.window.getContentBounds()),
      this.geometry,
      this.alphaMaskCache,
    ));
    if (this.ignored === shouldIgnore) return;
    this.ignored = shouldIgnore;
    // §9.2：Linux 不假设 forward:true 可用（行为不一致），由主进程光标
    // 轮询恢复交互；仅非 Linux 平台透传鼠标事件到下层应用。
    if (this.options.forward === false) {
      this.window.setIgnoreMouseEvents(shouldIgnore);
    } else {
      this.window.setIgnoreMouseEvents(shouldIgnore, { forward: true });
    }
  }
}
