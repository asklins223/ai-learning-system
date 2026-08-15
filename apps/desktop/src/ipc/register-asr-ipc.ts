/**
 * P6 §13：本地 ASR IPC 通道注册（main 侧）。
 *
 * 安全（02 合同 §8）：
 * - 每个 IPC 校验 sender 是 Pet window（/companion/pet 同源路由）；
 * - payload 按 shared schema 校验；Float32Array 走结构化克隆（不 JSON）；
 * - 模型路径由 main 从受信配置 resolveAsrModelConfig 注入，renderer 不能
 *   传任意路径（杜绝加载任意本地 onnx 的路径穿越面）；
 * - 不暴露原始 ipcRenderer，也不暴露 dispose/kill utility process 的任意控制。
 */

import { app, ipcMain, systemPreferences, type IpcMainInvokeEvent } from "electron";
import {
  ASR_IPC_CHANNELS,
  asrIpcProbePayloadV1Schema,
  asrIpcRecognizePayloadV1Schema,
  asrRuntimeCapabilityV1Schema,
  type AsrRuntimeCapabilityV1,
} from "@ailearn/shared";
import { requireTrustedSender } from "./validate-sender.ts";
import { logger } from "../logger.ts";
import { asrManager, resolveAsrModelConfig, type AsrModelConfigSourceV1 } from "../voice/asr-manager.ts";

export interface AsrIpcContext {
  origin: string;
  getPetWindow(): { isDestroyed(): boolean; webContents: { id: number } } | null;
  /** 主窗口（学习卡练习等主流程页面也使用本地 ASR——2026-08-14 接线） */
  getMainWindow(): { isDestroyed(): boolean; webContents: { id: number } } | null;
  /** 模型目录（受信来源）；null → 从环境变量解析 */
  getModelConfig(): AsrModelConfigSourceV1 | null;
}

function requireMainOrPetSender(event: IpcMainInvokeEvent, context: AsrIpcContext): void {
  const pet = context.getPetWindow();
  const petId = pet && !pet.isDestroyed() ? pet.webContents.id : null;
  const main = context.getMainWindow();
  const mainId = main && !main.isDestroyed() ? main.webContents.id : null;
  // main 窗口：webContents id 匹配 + 同源即可（主窗口承载全部业务路由）；
  // pet 窗口：额外要求 /companion/pet 路由（isTrustedSender role=pet 校验）。
  if (event.sender.id === mainId) {
    requireTrustedSender(event, mainId, context.origin, "main");
    return;
  }
  requireTrustedSender(event, petId, context.origin, "pet");
}

function resolveCapability(context: AsrIpcContext): AsrRuntimeCapabilityV1 {
  const resolved = resolveAsrModelConfig(context.getModelConfig());
  if (!resolved.available) {
    return { available: false, reason: "not-configured" };
  }
  // 2026-08-12（P6 真机验证）：注入真实 arch（页面 staticCompatPass 门槛）。
  // process.arch 在 main 进程始终可用；非 x64/arm64（如 ia32）本地路由
  // 不支持——按 unsupported-platform 关闭。
  const arch = process.arch === "x64" || process.arch === "arm64" ? process.arch : null;
  if (!arch) return { available: false, reason: "unsupported-platform" };
  return { available: true, config: resolved.config, arch };
}

export function registerAsrIpc(context: AsrIpcContext): () => void {
  const handlers: string[] = [];
  const handle = (
    channel: string,
    callback: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown> | unknown,
  ) => {
    ipcMain.handle(channel, callback);
    handlers.push(channel);
  };

  handle(ASR_IPC_CHANNELS.capability, (event) => {
    requireMainOrPetSender(event, context);
    const capability = resolveCapability(context);
    return asrRuntimeCapabilityV1Schema.parse(capability);
  });

  // 2026-08-12（麦克风权限修复）：录音前由 renderer 触发（app 已前台激活），
  // 主进程主动 askForMediaAccess 请求 macOS TCC 麦克风授权。启动时（后台）
  // 请求不弹窗且返回 false → getUserMedia 拿全静音流 → 识别永远只有单字。
  handle(ASR_IPC_CHANNELS.ensurePermission, async (event) => {
    requireMainOrPetSender(event, context);
    try {
      const status = systemPreferences.getMediaAccessStatus("microphone");
      if (status === "granted") return { granted: true, status };
      if (status === "not-determined") {
        // 2026-08-12：TCC 弹窗只会在 app 处于前台激活时出现。桌宠窗口
        // 是 skipTaskbar 无框窗口，点击不一定让 app 成为 active——强制
        // app.focus({steal:true}) 确保弹窗能正常弹出。
        app.focus({ steal: true });
        const granted = await systemPreferences.askForMediaAccess("microphone");
        logger.info(`[app] ensurePermission askForMediaAccess -> granted=${granted}`);
        return { granted, status: granted ? "granted" : "denied" };
      }
      // denied / restricted：提示用户去系统设置授权，不静默失败。
      logger.warn(`[app] ensurePermission: microphone status=${status} (not requestable)`);
      return { granted: false, status };
    } catch (error) {
      return { granted: false, status: "error", error: error instanceof Error ? error.message : String(error) };
    }
  });

  handle(ASR_IPC_CHANNELS.probe, async (event, payload: unknown) => {
    requireMainOrPetSender(event, context);
    const parsed = asrIpcProbePayloadV1Schema.safeParse(payload);
    if (!parsed.success) throw new Error("INVALID_ASR_PAYLOAD");
    const resolved = resolveAsrModelConfig(context.getModelConfig());
    if (!resolved.available) {
      return { version: 1, ok: false, error: "model_unavailable" };
    }
    return asrManager.probe(resolved.config, parsed.data.testAudio);
  });

  handle(ASR_IPC_CHANNELS.recognize, async (event, payload: unknown) => {
    requireMainOrPetSender(event, context);
    const parsed = asrIpcRecognizePayloadV1Schema.safeParse(payload);
    if (!parsed.success) throw new Error("INVALID_ASR_PAYLOAD");
    const resolved = resolveAsrModelConfig(context.getModelConfig());
    if (!resolved.available) {
      return { version: 1, ok: false, error: "model_unavailable", recoverable: true };
    }
    return asrManager.recognize(
      resolved.config,
      parsed.data.pcm,
      parsed.data.sampleRate ?? 16000,
    );
  });

  handle(ASR_IPC_CHANNELS.dispose, async (event) => {
    requireMainOrPetSender(event, context);
    await asrManager.dispose();
    return { version: 1, ok: true };
  });

  return () => {
    for (const channel of handlers) ipcMain.removeHandler(channel);
  };
}
