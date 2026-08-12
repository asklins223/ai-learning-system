import type { IpcRenderer } from "electron";
import {
  desktopPetWindowStateV1Schema,
  desktopLifecycleEventV1Schema,
  ASR_IPC_CHANNELS,
  type DesktopPetApiV1,
  type DesktopAsrApiV1,
} from "@ailearn/shared";
import { PET_IPC_CHANNELS } from "./ipc/contract";

export function createDesktopPetApi(ipcRenderer: Pick<IpcRenderer, "invoke" | "on" | "removeListener">): DesktopPetApiV1 {
  const api: DesktopPetApiV1 = {
    getCapabilities: () => ipcRenderer.invoke(PET_IPC_CHANNELS.getCapabilities),
    getDeviceSessionId: () => ipcRenderer.invoke(PET_IPC_CHANNELS.getDeviceSessionId),
    getWindowState: () => ipcRenderer.invoke(PET_IPC_CHANNELS.getWindowState),
    registerHitGeometry: (input) => ipcRenderer.invoke(PET_IPC_CHANNELS.registerHitGeometry, input),
    setInteractionMode: (mode) => ipcRenderer.invoke(PET_IPC_CHANNELS.setInteractionMode, mode),
    requestTextInputFocus: () => ipcRenderer.invoke(PET_IPC_CHANNELS.requestTextInputFocus),
    releaseTextInputFocus: () => ipcRenderer.invoke(PET_IPC_CHANNELS.releaseTextInputFocus),
    setPetModeEnabled: (enabled) => ipcRenderer.invoke(PET_IPC_CHANNELS.setPetModeEnabled, enabled),
    setAlwaysOnTop: (enabled) => ipcRenderer.invoke(PET_IPC_CHANNELS.setAlwaysOnTop, enabled),
    setLocked: (locked) => ipcRenderer.invoke(PET_IPC_CHANNELS.setLocked, locked),
    dragBy: (deltaX, deltaY) => ipcRenderer.invoke(PET_IPC_CHANNELS.dragBy, deltaX, deltaY),
    setPetScale: (scale) => ipcRenderer.invoke(PET_IPC_CHANNELS.setPetScale, scale),
    setPrivacyMode: (enabled) => ipcRenderer.invoke(PET_IPC_CHANNELS.setPrivacyMode, enabled),
    moveToSafePosition: () => ipcRenderer.invoke(PET_IPC_CHANNELS.moveToSafePosition),
    openMainRoute: (route) => ipcRenderer.invoke(PET_IPC_CHANNELS.openMainRoute, route),
    reportBootstrap: (result) => ipcRenderer.invoke(PET_IPC_CHANNELS.reportBootstrap, result),
    hidePet: () => ipcRenderer.invoke(PET_IPC_CHANNELS.hidePet),
    onWindowStateChanged: (callback) => {
      const listener = (_event: unknown, value: unknown) => {
        const parsed = desktopPetWindowStateV1Schema.safeParse(value);
        if (parsed.success) callback(parsed.data);
      };
      ipcRenderer.on(PET_IPC_CHANNELS.windowStateChanged, listener);
      return () => ipcRenderer.removeListener(PET_IPC_CHANNELS.windowStateChanged, listener);
    },
    onLifecycleEvent: (callback) => {
      const listener = (_event: unknown, value: unknown) => {
        const parsed = desktopLifecycleEventV1Schema.safeParse(value);
        if (parsed.success) callback(parsed.data);
      };
      ipcRenderer.on(PET_IPC_CHANNELS.lifecycleEvent, listener);
      return () => ipcRenderer.removeListener(PET_IPC_CHANNELS.lifecycleEvent, listener);
    },
  };
  return api;
}

/**
 * P6 §13：本地 ASR 窄接口（Pet preload 暴露到 window.asrAPI）。
 * browser fallback 不提供该 API（renderer 检测不存在即走云端/文字降级）。
 */
export function createDesktopAsrApi(ipcRenderer: Pick<IpcRenderer, "invoke">): DesktopAsrApiV1 {
  return {
    getCapability: () => ipcRenderer.invoke(ASR_IPC_CHANNELS.capability),
    probe: (testAudio) => ipcRenderer.invoke(ASR_IPC_CHANNELS.probe, { version: 1, testAudio }),
    recognize: (pcm, sampleRate) => ipcRenderer.invoke(ASR_IPC_CHANNELS.recognize, { version: 1, pcm, sampleRate }),
    dispose: () => ipcRenderer.invoke(ASR_IPC_CHANNELS.dispose),
    // 2026-08-12（麦克风权限修复）：录音前由 renderer 显式触发主进程
    // askForMediaAccess——macOS 上只有 app 前台激活时才会弹 TCC 授权框；
    // 启动时（后台/未激活）请求会静默返回 false、流全静音。
    ensurePermission: () => ipcRenderer.invoke(ASR_IPC_CHANNELS.ensurePermission),
  };
}
