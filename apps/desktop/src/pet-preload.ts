/**
 * Preload bridge — Pet Window 专用。
 *
 * 暴露两件东西：
 * - `desktopAPI`：桌宠窗口/交互能力（02 合同 §8 typed preload）；
 * - `asrAPI`：P6 §13 本地 SenseVoice ASR 窄接口（utility process 转发）。
 *
 * 两者都是逐动作窄接口，不暴露原始 ipcRenderer。
 */

import { contextBridge, ipcRenderer } from "electron";
import { createDesktopPetApi } from "./desktop-api-bridge";
import { createDesktopAsrApi } from "./desktop-api-bridge";
import { createPetCompanionBridgeApi } from "./companion-bridge-api";

contextBridge.exposeInMainWorld("desktopAPI", createDesktopPetApi(ipcRenderer));
contextBridge.exposeInMainWorld("asrAPI", createDesktopAsrApi(ipcRenderer));
// P5：Pet ↔ Main Bridge V2（窄接口；dispatch 由 broker 校验 sender 与 freshness）。
contextBridge.exposeInMainWorld("companionBridge", createPetCompanionBridgeApi(ipcRenderer));
