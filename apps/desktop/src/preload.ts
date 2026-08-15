/**
 * Preload bridge — Main Window 专用。
 *
 * 只暴露最小面：
 * - `getVersion`：版本查询；
 * - `getPetModeEnabled` / `setPetModeEnabled`：2026-08-12 新增，设置页
 *   （个人中心 → 设置）桌宠开关。main window 专用 IPC，sender 校验在
 *   register-pet-ipc 的 desktop: 通道。
 * - `asrAPI`：2026-08-14 新增——主窗口学习卡练习的语音回答同样走本地
 *   SenseVoice ASR（utility process 转发；与 Pet 窗口同一实现与 IPC）。
 *
 * pet-only 能力（registerHitGeometry/dragBy/hidePet/openMainRoute 等）只
 * 通过 Pet Window 的 pet-preload 暴露；不向 main window 暴露原始 ipcRenderer。
 */

import { contextBridge, ipcRenderer } from "electron";
import { createMainCompanionBridgeApi } from "./companion-bridge-api";
import { createDesktopAsrApi } from "./desktop-api-bridge";

contextBridge.exposeInMainWorld("desktopAPI", {
  getVersion: () => ipcRenderer.invoke("desktop:get-version"),
  getPetModeEnabled: () => ipcRenderer.invoke("desktop:get-pet-mode"),
  setPetModeEnabled: (enabled: boolean) => ipcRenderer.invoke("desktop:set-pet-mode", enabled),
});

// P5：Main ↔ Pet Bridge V2（§14.2 窄接口；broker 校验 sender，不暴露 channel）。
contextBridge.exposeInMainWorld("companionBridge", createMainCompanionBridgeApi(ipcRenderer));

// 方案 16 §7.5：学习卡练习语音本地优先 ASR（asrAPI 缺失时浏览器自动回退云端）。
contextBridge.exposeInMainWorld("asrAPI", createDesktopAsrApi(ipcRenderer));
