/**
 * Preload bridge — Main Window 专用。
 *
 * 只暴露最小面：
 * - `getVersion`：版本查询；
 * - `getPetModeEnabled` / `setPetModeEnabled`：2026-08-12 新增，设置页
 *   （个人中心 → 设置）桌宠开关。main window 专用 IPC，sender 校验在
 *   register-pet-ipc 的 desktop: 通道。
 *
 * pet-only 能力（registerHitGeometry/dragBy/hidePet/openMainRoute 等）只
 * 通过 Pet Window 的 pet-preload 暴露；不向 main window 暴露原始 ipcRenderer。
 */

import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("desktopAPI", {
  getVersion: () => ipcRenderer.invoke("desktop:get-version"),
  getPetModeEnabled: () => ipcRenderer.invoke("desktop:get-pet-mode"),
  setPetModeEnabled: (enabled: boolean) => ipcRenderer.invoke("desktop:set-pet-mode", enabled),
});
