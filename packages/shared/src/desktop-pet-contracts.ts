import { z } from "zod";

/** Shared V1 contracts for the Electron Pet Window and its typed preload bridge. */

export const desktopPetInteractionModeV1Schema = z.enum([
  "passive",
  "interactive",
  "text_input",
  "dragging",
  "accessibility_focus",
]);
export type DesktopPetInteractionModeV1 = z.infer<
  typeof desktopPetInteractionModeV1Schema
>;

export const desktopPetScaleV1Schema = z.union([
  z.literal(0.85),
  z.literal(1),
  z.literal(1.15),
  z.literal(1.25),
]);
export type DesktopPetScaleV1 = z.infer<typeof desktopPetScaleV1Schema>;

const desktopPetBoundsV1Schema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().positive(),
  height: z.number().finite().positive(),
}).strict();

export const desktopPetCapabilitiesV1Schema = z.object({
  version: z.literal(1),
  platform: z.enum(["darwin", "win32", "linux"]),
  transparentWindow: z.boolean(),
  forwardedClickThrough: z.boolean(),
  showInactive: z.boolean(),
  contentProtection: z.boolean(),
}).strict();
export type DesktopPetCapabilitiesV1 = z.infer<
  typeof desktopPetCapabilitiesV1Schema
>;

export const desktopPetWindowStateV1Schema = z.object({
  version: z.literal(1),
  revision: z.number().int().nonnegative(),
  visible: z.boolean(),
  displayId: z.string().min(1).max(200),
  boundsDip: desktopPetBoundsV1Schema,
  contentSizeCssPx: z.object({
    width: z.number().int().min(560).max(621),
    height: z.literal(520),
  }).strict(),
  scaleFactor: z.number().finite().positive(),
  petModeEnabled: z.boolean(),
  petScale: desktopPetScaleV1Schema,
  locked: z.boolean(),
  alwaysOnTop: z.boolean(),
  privacyMode: z.boolean(),
  interactionMode: desktopPetInteractionModeV1Schema,
}).strict();
export type DesktopPetWindowStateV1 = z.infer<
  typeof desktopPetWindowStateV1Schema
>;

export const petBootstrapResultV1Schema = z.discriminatedUnion("kind", [
  z.object({ version: z.literal(1), kind: z.literal("ready") }).strict(),
  z.object({ version: z.literal(1), kind: z.literal("auth_required") }).strict(),
  z.object({ version: z.literal(1), kind: z.literal("global_off") }).strict(),
  z.object({
    version: z.literal(1),
    kind: z.literal("fatal"),
    code: z.enum(["UNSUPPORTED_PLATFORM", "PET_BOOTSTRAP_FAILED"]),
  }).strict(),
]);
export type PetBootstrapResultV1 = z.infer<typeof petBootstrapResultV1Schema>;

export const desktopLifecycleEventV1Schema = z.discriminatedUnion("kind", [
  z.object({
    version: z.literal(1),
    kind: z.literal("system_suspended"),
    reason: z.enum(["sleep", "screen_locked"]),
  }).strict(),
  z.object({ version: z.literal(1), kind: z.literal("system_resumed") }).strict(),
  z.object({ version: z.literal(1), kind: z.literal("displays_changed") }).strict(),
  z.object({ version: z.literal(1), kind: z.literal("temporary_hidden") }).strict(),
  z.object({ version: z.literal(1), kind: z.literal("app_quitting") }).strict(),
  // 2026-08-11（性能专项）：窗口被完全遮挡（occluded）时暂停渲染（rAF/PIXI
  // ticker），但不中止会话/语音——与 temporary_hidden（主动隐藏、中止流）语义不同。
  z.object({ version: z.literal(1), kind: z.literal("occluded") }).strict(),
  z.object({ version: z.literal(1), kind: z.literal("unoccluded") }).strict(),
]);
export type DesktopLifecycleEventV1 = z.infer<
  typeof desktopLifecycleEventV1Schema
>;

const allowedMainRouteV1Schema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("conversation"),
    conversationId: z.string().uuid().optional(),
  }).strict(),
  z.object({
    kind: z.literal("settings"),
    // "pet" = 设置页“桌宠伴星”选项卡（伴星菜单当前唯一入口）；
    // "model" = “AI 使用与数据”（AI_CONSENT_REQUIRED 引导入口，
    //  2026-08-12+ 15a 新增）；
    // 保留 "companion"/"voice" 兼容既有调用方与未来入口。
    section: z.enum(["companion", "voice", "pet", "model"]),
  }).strict(),
  z.object({ kind: z.literal("review") }).strict(),
  z.object({ kind: z.literal("card"), cardId: z.string().uuid() }).strict(),
  z.object({
    kind: z.literal("star_map"),
    keyPointId: z.string().uuid().optional(),
  }).strict(),
  z.object({
    kind: z.literal("learning_session"),
    cardId: z.string().uuid(),
    keyPointId: z.string().uuid(),
    sessionId: z.string().uuid(),
    origin: z.enum(["card", "review", "star_map", "now"]),
  }).strict(),
]);
export { allowedMainRouteV1Schema };
export type AllowedMainRouteV1 = z.infer<typeof allowedMainRouteV1Schema>;

const petHitRegionV1Schema = z.object({
  id: z.enum([
    "bubble",
    "composer",
    "menu",
    "menu_trigger",
    "drag_handle",
    "voice_control",
    "character",
  ]),
  kind: z.enum(["rect", "alpha_mask", "polygon"]),
  rect: z.object({
    x: z.number().finite().nonnegative(),
    y: z.number().finite().nonnegative(),
    width: z.number().finite().positive(),
    height: z.number().finite().positive(),
  }).strict(),
  polygon: z.array(z.object({
    x: z.number().finite(),
    y: z.number().finite(),
  }).strict()).max(64).optional(),
  mask: z.object({
    width: z.number().int().positive().max(128),
    height: z.number().int().positive().max(128),
    bitsBase64: z.string().max(4096),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict().optional(),
}).strict();

export const petHitGeometryV1Schema = z.object({
  version: z.literal(1),
  revision: z.number().int().nonnegative(),
  contentWidth: z.number().int().min(560).max(621),
  contentHeight: z.literal(520),
  petScale: desktopPetScaleV1Schema,
  regions: z.array(petHitRegionV1Schema).max(8),
}).strict();
export type PetHitGeometryV1 = z.infer<typeof petHitGeometryV1Schema>;

export interface DesktopPetApiV1 {
  getCapabilities(): Promise<DesktopPetCapabilitiesV1>;
  getDeviceSessionId(): Promise<string>;
  getWindowState(): Promise<DesktopPetWindowStateV1>;
  registerHitGeometry(input: PetHitGeometryV1): Promise<void>;
  setInteractionMode(mode: DesktopPetInteractionModeV1): Promise<void>;
  requestTextInputFocus(): Promise<void>;
  releaseTextInputFocus(): Promise<void>;
  setPetModeEnabled(enabled: boolean): Promise<void>;
  setAlwaysOnTop(enabled: boolean): Promise<void>;
  setLocked(enabled: boolean): Promise<void>;
  /**
   * 拖动：把 Pet Window 按屏幕坐标增量移动（由 renderer 合帧后驱动）。
   * 主进程校验 locked 状态后移动；位置在拖动结束后去抖持久化。
   */
  dragBy(deltaX: number, deltaY: number): Promise<void>;
  setPetScale(scale: DesktopPetScaleV1): Promise<void>;
  setPrivacyMode(enabled: boolean): Promise<void>;
  moveToSafePosition(): Promise<void>;
  openMainRoute(route: AllowedMainRouteV1): Promise<void>;
  reportBootstrap(result: PetBootstrapResultV1): Promise<void>;
  hidePet(): Promise<void>;
  onWindowStateChanged(callback: (state: DesktopPetWindowStateV1) => void): () => void;
  onLifecycleEvent(callback: (event: DesktopLifecycleEventV1) => void): () => void;
}
