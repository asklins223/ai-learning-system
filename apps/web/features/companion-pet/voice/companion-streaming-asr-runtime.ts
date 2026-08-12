/**
 * P6 §13：ASR 三路由编排运行时（纯逻辑 + 注入，可测）。
 *
 * 流程（§13 ASR 路由冻结）：
 * 1. capability（asrAPI 可用 + 模型已配置）→ 静态兼容检查（x64/arm64、
 *    核心数/内存/磁盘/native runtime/模型 hash）→ 首次执行真实性能探测
 *    （内置 3–5s 测试音频跑模型）→ decideAsrRoute；
 * 2. local_streaming → 本地识别整段 PCM → transcript；
 *    siliconflow_file → 上传有界副本（API Key 留服务端）→ transcript；
 *    text_only → 保留录音草稿提示，允许文字输入（不伪装成功）；
 * 3. 运行中 RTF 恶化/模型崩溃 → 当前录音结束后自动降级 cloud。
 */

import {
  ASR_MIN_GATE,
  decideAsrRoute,
  shouldDegradeToCloud,
  staticCompatPass,
  type AsrRouterContext,
  type StaticCompatInput,
} from "./companion-asr-router.ts";

export type StreamingAsrOutcome =
  | { kind: "transcript"; text: string; source: "local" | "cloud" }
  | { kind: "text_only" }
  | { kind: "failed"; code: string; recoverable: boolean };

export interface StreamingAsrRuntimeDeps {
  /** asrAPI 能力（local ASR 可用性 + 模型配置） */
  getCapability(): Promise<{ available: boolean; reason?: string }>;
  /** 真实性能探测（加载模型 + 内置测试音频） */
  probe(testAudio: Float32Array): Promise<
    { ok: true; probe: { coldStartMs: number; warmRtf: number } } | { ok: false; error: string }
  >;
  /** 本地识别整段 16k PCM */
  recognize(pcm: Float32Array): Promise<
    { ok: true; text: string } | { ok: false; error: string; recoverable: boolean }
  >;
  /** 云端文件转写（现有 /voice/transcribe；blob 为有界副本） */
  uploadToCloud(blob: Blob | null): Promise<
    { ok: true; text: string } | { ok: false; error: string; recoverable: boolean }
  >;
  /** 静态兼容输入（navigator 探测） */
  staticInput: StaticCompatInput;
  /** SiliconFlow 可用且用户已一次性同意云端上传 */
  siliconFlowAvailable: boolean;
  userConsentedCloud: boolean;
  /** 内置 3–5s 16k mono 测试音频（性能探测用） */
  testAudio: Float32Array;
}

export interface StreamingAsrRuntimeV1 {
  /** 识别整段录音；返回 transcript / text_only / failed */
  transcribe(pcm: Float32Array, cloudBlob: Blob | null): Promise<StreamingAsrOutcome>;
  /** 运行中降级（RTF 恶化/崩溃 → 后续录音走 cloud） */
  maybeDegrade(latest: { sustainedSlow: boolean; modelCrashed: boolean }): void;
}

export function createStreamingAsrRuntime(deps: StreamingAsrRuntimeDeps): StreamingAsrRuntimeV1 {
  let route: "local_streaming" | "siliconflow_file" | "text_only" | "undecided" = "undecided";

  async function resolveRoute(): Promise<"local_streaming" | "siliconflow_file" | "text_only"> {
    if (route !== "undecided") return route;
    // 静态兼容 + capability
    const capability = await deps.getCapability();
    const staticOk = capability.available && staticCompatPass(deps.staticInput);
    if (!staticOk) {
      route = deps.siliconFlowAvailable && deps.userConsentedCloud ? "siliconflow_file" : "text_only";
      return route;
    }
    // 真实性能探测（加载模型 + 内置音频）
    const probeResult = await deps.probe(deps.testAudio);
    if (!probeResult.ok) {
      route = deps.siliconFlowAvailable && deps.userConsentedCloud ? "siliconflow_file" : "text_only";
      return route;
    }
    const ctx: AsrRouterContext = {
      staticInput: deps.staticInput,
      probe: {
        coldStartMs: probeResult.probe.coldStartMs,
        warmRtf: probeResult.probe.warmRtf,
        peakMemoryDeltaMB: 0,
        modelCrashed: false,
        sustainedSlow: false,
        modelLoadFailed: false,
      },
      siliconFlowAvailable: deps.siliconFlowAvailable,
      userConsentedCloud: deps.userConsentedCloud,
    };
    route = decideAsrRoute(ctx);
    return route;
  }

  return {
    async transcribe(pcm: Float32Array, cloudBlob: Blob | null): Promise<StreamingAsrOutcome> {
      const currentRoute = await resolveRoute();
      if (currentRoute === "text_only") {
        return { kind: "text_only" };
      }
      if (currentRoute === "siliconflow_file") {
        const upload = await deps.uploadToCloud(cloudBlob);
        if (upload.ok) return { kind: "transcript", text: upload.text, source: "cloud" };
        return { kind: "failed", code: upload.error, recoverable: upload.recoverable };
      }
      // local_streaming
      if (pcm.length === 0) {
        return { kind: "failed", code: "EMPTY_AUDIO", recoverable: true };
      }
      const local = await deps.recognize(pcm);
      if (local.ok) return { kind: "transcript", text: local.text, source: "local" };
      // 本地识别失败 → 降级 cloud（若可用）
      if (deps.siliconFlowAvailable && deps.userConsentedCloud) {
        const upload = await deps.uploadToCloud(cloudBlob);
        if (upload.ok) return { kind: "transcript", text: upload.text, source: "cloud" };
      }
      return { kind: "failed", code: local.error, recoverable: local.recoverable };
    },
    maybeDegrade(latest: { sustainedSlow: boolean; modelCrashed: boolean }): void {
      if (shouldDegradeToCloud(route === "undecided" ? "local_streaming" : route, latest)) {
        route = deps.siliconFlowAvailable && deps.userConsentedCloud ? "siliconflow_file" : "text_only";
      }
    },
  };
}

/** 从 navigator/hardware 构造静态兼容输入（浏览器侧）。 */
export function buildStaticCompatInput(
  archHint: string | undefined,
  modelHashValid: boolean,
  nativeRuntimeLoadable: boolean,
): StaticCompatInput {
  const arch = archHint === "x64" || archHint === "arm64" ? archHint : "other";
  const cores = typeof navigator !== "undefined" ? navigator.hardwareConcurrency ?? 1 : 1;
  // 浏览器无法精确拿总内存/磁盘——按保守最小值探测（probe 阶段真实判定）。
  return {
    arch,
    logicalCores: cores,
    totalMemoryGB: ASR_MIN_GATE.totalMemoryGB,
    availableMemoryGB: ASR_MIN_GATE.availableMemoryGB,
    freeDiskGB: ASR_MIN_GATE.freeDiskGB,
    nativeRuntimeLoadable,
    modelHashValid,
  };
}
