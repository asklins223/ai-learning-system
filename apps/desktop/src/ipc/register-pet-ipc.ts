import { app, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import {
  allowedMainRouteV1Schema,
  desktopPetCapabilitiesV1Schema,
  desktopPetInteractionModeV1Schema,
  desktopPetScaleV1Schema,
  desktopPetWindowStateV1Schema,
  petBootstrapResultV1Schema,
  petHitGeometryV1Schema,
  type AllowedMainRouteV1,
  type DesktopPetInteractionModeV1,
  type DesktopPetScaleV1,
  type PetBootstrapResultV1,
  type PetHitGeometryV1,
} from "@ailearn/shared";
import { requireTrustedSender, isTrustedSender } from "./validate-sender";
import { PET_IPC_CHANNELS } from "./contract";
import { logger } from "../logger";
export { PET_IPC_CHANNELS } from "./contract";

export interface PetIpcContext {
  origin: string;
  getPetWindow(): BrowserWindow | null;
  getMainWindow(): BrowserWindow | null;
  getCapabilities(): unknown;
  getDeviceSessionId(): string;
  getWindowState(): unknown;
  onHitGeometry(input: PetHitGeometryV1): void;
  onInteractionMode(mode: DesktopPetInteractionModeV1): void;
  /** 合帧后的屏幕坐标拖动增量；主进程只移动窗口，结束后再持久化。 */
  onDragBy(deltaX: number, deltaY: number): void;
  requestTextInputFocus(): void;
  releaseTextInputFocus(): void;
  setPetModeEnabled(enabled: boolean): void;
  /** 2026-08-12：设置页开关——读取当前 petModeEnabled（无偏好时按默认 true） */
  getPetModeEnabled(): boolean;
  setAlwaysOnTop(enabled: boolean): void;
  setLocked(locked: boolean): void;
  setPetScale(scale: DesktopPetScaleV1): void;
  setPrivacyMode(enabled: boolean): void;
  moveToSafePosition(): void;
  openMainRoute(route: AllowedMainRouteV1): void;
  reportBootstrap(result: PetBootstrapResultV1): void;
  hidePet(): void;
  openExternal(url: string): void;
  quit(): void;
}

export function registerPetIpc(context: PetIpcContext): () => void {
  const handlers: string[] = [];
  const handle = (channel: string, callback: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => {
    ipcMain.handle(channel, callback);
    handlers.push(channel);
  };

  const senderId = (role: "main" | "pet"): number | null => {
    const window = role === "main" ? context.getMainWindow() : context.getPetWindow();
    return window && !window.isDestroyed() ? window.webContents.id : null;
  };

  const requireRole = (event: IpcMainInvokeEvent, role: "main" | "pet"): void => {
    requireTrustedSender(event, senderId(role), context.origin, role);
  };

  const requireEitherRole = (event: IpcMainInvokeEvent): void => {
    const mainId = senderId("main");
    const petId = senderId("pet");
    if (
      !isTrustedSender(event, mainId, context.origin, "main")
      && !isTrustedSender(event, petId, context.origin, "pet")
    ) {
      throw new Error("UNTRUSTED_DESKTOP_SENDER");
    }
  };

  handle(PET_IPC_CHANNELS.getCapabilities, (event) => {
    requireEitherRole(event);
    return desktopPetCapabilitiesV1Schema.parse(context.getCapabilities());
  });

  handle(PET_IPC_CHANNELS.getDeviceSessionId, (event) => {
    requireEitherRole(event);
    return context.getDeviceSessionId();
  });

  handle(PET_IPC_CHANNELS.getWindowState, (event) => {
    requireEitherRole(event);
    return desktopPetWindowStateV1Schema.parse(context.getWindowState());
  });

  handle(PET_IPC_CHANNELS.registerHitGeometry, (event, input) => {
    requireRole(event, "pet");
    context.onHitGeometry(petHitGeometryV1Schema.parse(input));
  });

  handle(PET_IPC_CHANNELS.setInteractionMode, (event, mode) => {
    requireRole(event, "pet");
    context.onInteractionMode(desktopPetInteractionModeV1Schema.parse(mode));
  });

  handle(PET_IPC_CHANNELS.requestTextInputFocus, (event) => {
    requireRole(event, "pet");
    context.requestTextInputFocus();
  });

  handle(PET_IPC_CHANNELS.releaseTextInputFocus, (event) => {
    requireRole(event, "pet");
    context.releaseTextInputFocus();
  });

  handle(PET_IPC_CHANNELS.setPetModeEnabled, (event, enabled) => {
    // 2026-08-11 修复：唯一调用方是 pet 窗口"关闭桌宠"菜单（PetMenu），
    // 此前 requireRole("main") 使该功能必抛 UNTRUSTED_DESKTOP_SENDER。
    // 与 setLocked/setAlwaysOnTop 一致，允许 main 或 pet 窗口。
    requireEitherRole(event);
    if (typeof enabled !== "boolean") throw new Error("INVALID_DESKTOP_PAYLOAD");
    context.setPetModeEnabled(enabled);
    logger.info({ channel: PET_IPC_CHANNELS.setPetModeEnabled, enabled }, "pet ipc: pet mode toggled");
    return { ok: true, enabled };
  });
  // 2026-08-12：设置页（main window）桌宠开关——读取/设置 petModeEnabled。
  // main 窗口专用通道（desktop: 前缀），sender 必须是 main window 同源页面。
  handle(PET_IPC_CHANNELS.desktopGetPetMode, (event) => {
    requireTrustedSender(
      event,
      context.getMainWindow() && !context.getMainWindow()!.isDestroyed()
        ? context.getMainWindow()!.webContents.id
        : null,
      context.origin,
      "main",
    );
    return { ok: true, enabled: context.getPetModeEnabled() };
  });
  handle(PET_IPC_CHANNELS.desktopSetPetMode, (event, enabled: unknown) => {
    requireTrustedSender(
      event,
      context.getMainWindow() && !context.getMainWindow()!.isDestroyed()
        ? context.getMainWindow()!.webContents.id
        : null,
      context.origin,
      "main",
    );
    if (typeof enabled !== "boolean") throw new Error("INVALID_DESKTOP_PAYLOAD");
    context.setPetModeEnabled(enabled);
    return { ok: true, enabled };
  });

  handle(PET_IPC_CHANNELS.setAlwaysOnTop, (event, enabled) => {
    requireEitherRole(event);
    if (typeof enabled !== "boolean") throw new Error("INVALID_DESKTOP_PAYLOAD");
    context.setAlwaysOnTop(enabled);
    logger.info({ channel: PET_IPC_CHANNELS.setAlwaysOnTop, enabled }, "pet ipc: always-on-top toggled");
  });

  handle(PET_IPC_CHANNELS.setLocked, (event, locked) => {
    requireEitherRole(event);
    if (typeof locked !== "boolean") throw new Error("INVALID_DESKTOP_PAYLOAD");
    context.setLocked(locked);
    logger.info({ channel: PET_IPC_CHANNELS.setLocked, locked }, "pet ipc: position locked/unlocked");
  });

  handle(PET_IPC_CHANNELS.dragBy, (event, deltaX, deltaY) => {
    requireRole(event, "pet");
    if (
      typeof deltaX !== "number" || typeof deltaY !== "number" ||
      !Number.isFinite(deltaX) || !Number.isFinite(deltaY) ||
      Math.abs(deltaX) > 2000 || Math.abs(deltaY) > 2000
    ) {
      throw new Error("INVALID_DESKTOP_PAYLOAD");
    }
    context.onDragBy(deltaX, deltaY);
  });

  handle(PET_IPC_CHANNELS.setPetScale, (event, scale) => {
    requireEitherRole(event);
    context.setPetScale(desktopPetScaleV1Schema.parse(scale));
    logger.info({ channel: PET_IPC_CHANNELS.setPetScale, scale }, "pet ipc: scale changed");
  });

  handle(PET_IPC_CHANNELS.setPrivacyMode, (event, enabled) => {
    requireEitherRole(event);
    if (typeof enabled !== "boolean") throw new Error("INVALID_DESKTOP_PAYLOAD");
    context.setPrivacyMode(enabled);
    logger.info({ channel: PET_IPC_CHANNELS.setPrivacyMode, enabled }, "pet ipc: privacy mode toggled");
  });

  handle(PET_IPC_CHANNELS.moveToSafePosition, (event) => {
    requireEitherRole(event);
    context.moveToSafePosition();
    logger.info({ channel: PET_IPC_CHANNELS.moveToSafePosition }, "pet ipc: moved to safe position");
  });

  handle(PET_IPC_CHANNELS.openMainRoute, (event, route) => {
    requireRole(event, "pet");
    context.openMainRoute(allowedMainRouteV1Schema.parse(route));
    logger.info({ channel: PET_IPC_CHANNELS.openMainRoute, kind: (route as AllowedMainRouteV1).kind }, "pet ipc: open main route");
  });

  handle(PET_IPC_CHANNELS.reportBootstrap, (event, result) => {
    requireRole(event, "pet");
    context.reportBootstrap(petBootstrapResultV1Schema.parse(result));
  });

  handle(PET_IPC_CHANNELS.hidePet, (event) => {
    requireRole(event, "pet");
    context.hidePet();
    logger.info({ channel: PET_IPC_CHANNELS.hidePet }, "pet ipc: pet hidden");
  });

  ipcMain.on(PET_IPC_CHANNELS.legacyOpenExternal, (event, url: unknown) => {
    if (!isTrustedSender(event, senderId("main"), context.origin, "main")) return;
    // 2026-08-11：仅信任 https 协议（不校验 host——如启用建议加白名单/确认 UI）
    if (typeof url === "string" && /^https:\/\//i.test(url)) context.openExternal(url);
  });
  handle(PET_IPC_CHANNELS.legacyGetVersion, (event) => {
    requireRole(event, "main");
    // 2026-08-11 修复：返回应用版本而非 Electron 内核版本（此前 UI 显示
    // "Electron 33.x" 且与 main.ts:660 的 v${app.getVersion()} 自相矛盾）。
    return app.getVersion();
  });

  return () => {
    for (const channel of handlers) ipcMain.removeHandler(channel);
    ipcMain.removeAllListeners(PET_IPC_CHANNELS.legacyOpenExternal);
  };
}
