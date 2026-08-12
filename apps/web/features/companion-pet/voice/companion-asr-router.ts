/**
 * P6 §13：ASR 三路由决策（纯逻辑，可测）。
 *
 * 路由（合同冻结）：
 * - local_streaming：静态兼容 + 真实性能探测（RTF/内存 Gate）通过 → 客户端 SenseVoice；
 * - siliconflow_file：硬件不足/模型加载失败/运行过慢 → 停止录音后上传完整音频；
 * - text_only：SiliconFlow 不可用或离线 → 保留录音草稿提示，允许文字输入。
 *
 * 静态兼容（第一层）：x64/arm64、native runtime 可加载、模型 hash 正确、
 * 可用内存/磁盘最低值。
 * 性能探测（第二层）：内置 3–5 秒测试音频跑真实模型，测冷启动与 warm RTF。
 * 初始 Gate：逻辑核心 ≥ 4；总内存 ≥ 8GB、探测时可用 ≥ 1.2GB；冷启动 ≤ 3s；
 * warm RTF ≤ 0.5；utility 进程峰值内存增量 ≤ 700MB；连续窗口 RTF > 0.8 或
 * 模型崩溃 → 当前录音结束后自动切 siliconflow_file。
 */

export type AsrRoute = "local_streaming" | "siliconflow_file" | "text_only";

export interface StaticCompatInput {
  arch: "x64" | "arm64" | "other";
  logicalCores: number;
  totalMemoryGB: number;
  availableMemoryGB: number;
  freeDiskGB: number;
  nativeRuntimeLoadable: boolean;
  modelHashValid: boolean;
}

export interface ProbeResult {
  coldStartMs: number;
  warmRtf: number;
  peakMemoryDeltaMB: number;
  modelCrashed: boolean;
  /** 连续窗口最近若干 RTF 是否持续恶化（>0.8） */
  sustainedSlow: boolean;
  modelLoadFailed: boolean;
}

export const ASR_MIN_GATE = Object.freeze({
  logicalCores: 4,
  totalMemoryGB: 8,
  availableMemoryGB: 1.2,
  freeDiskGB: 2,
  coldStartMs: 3_000,
  warmRtf: 0.5,
  peakMemoryDeltaMB: 700,
  sustainedRtf: 0.8,
});

export function staticCompatPass(input: StaticCompatInput): boolean {
  if (input.arch === "other") return false;
  if (!input.nativeRuntimeLoadable) return false;
  if (!input.modelHashValid) return false;
  if (input.logicalCores < ASR_MIN_GATE.logicalCores) return false;
  if (input.totalMemoryGB < ASR_MIN_GATE.totalMemoryGB) return false;
  if (input.availableMemoryGB < ASR_MIN_GATE.availableMemoryGB) return false;
  if (input.freeDiskGB < ASR_MIN_GATE.freeDiskGB) return false;
  return true;
}

export function probePass(probe: ProbeResult): boolean {
  if (probe.modelLoadFailed) return false;
  if (probe.modelCrashed) return false;
  if (probe.coldStartMs > ASR_MIN_GATE.coldStartMs) return false;
  if (probe.warmRtf > ASR_MIN_GATE.warmRtf) return false;
  if (probe.peakMemoryDeltaMB > ASR_MIN_GATE.peakMemoryDeltaMB) return false;
  if (probe.sustainedSlow) return false;
  return true;
}

export interface AsrRouterContext {
  staticInput: StaticCompatInput;
  probe: ProbeResult | null; // null = 尚未探测（local 不可信时降级）
  siliconFlowAvailable: boolean;
  userConsentedCloud: boolean; // 上传前一次性告知已同意
}

export function decideAsrRoute(ctx: AsrRouterContext): AsrRoute {
  const staticOk = staticCompatPass(ctx.staticInput);
  if (staticOk && ctx.probe && probePass(ctx.probe)) {
    return "local_streaming";
  }
  // 硬件不足/模型失败/过慢 → siliconflow_file（需可用 + 用户已被告知）
  if (ctx.siliconFlowAvailable && ctx.userConsentedCloud) {
    return "siliconflow_file";
  }
  return "text_only";
}

/** 运行中降级（RTF > 0.8 或崩溃 → 当前录音结束后自动切 siliconflow_file） */
export function shouldDegradeToCloud(
  currentRoute: AsrRoute,
  latestProbe: Pick<ProbeResult, "sustainedSlow" | "modelCrashed">,
): boolean {
  if (currentRoute !== "local_streaming") return false;
  return latestProbe.sustainedSlow || latestProbe.modelCrashed;
}
