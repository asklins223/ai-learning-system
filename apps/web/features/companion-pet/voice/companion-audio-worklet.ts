/**
 * P6 §13：AudioWorklet 采集处理器（16kHz mono PCM 输出）。
 *
 * - 浏览器 AudioContext 默认 sampleRate（通常 48k），SenseVoice 需 16k；
 *   worklet 内做整数倍下采样（48k→16k = 3:1；44.1k 用线性插值兜底）；
 * - 输出经 port.postMessage({ pcm }) 到主线程（Float32Array）；
 * - 挂起/恢复语义由 processMessage（suspended 标志）控制。
 *
 * 处理器源码以字符串注册（audioWorklet.addModule(URL.createObjectURL(...))），
 * 不能在 Node 测试环境直接 import 执行——纯逻辑部分（下采样）单独导出可测。
 */

export const ASR_WORKLET_NAME = "companion-asr-capture";

/** 48k→16k 整数 3:1 下采样（每 3 个样本取 1 个）。 */
export function downsampleTo16k(input: Float32Array, sampleRate: number): Float32Array {
  if (sampleRate === 16000) return input;
  const ratio = sampleRate / 16000;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  if (Math.abs(ratio - Math.round(ratio)) < 0.001) {
    // 整数倍（48k/32k/24k）：取每 ratio 个中的第 1 个
    const step = Math.round(ratio);
    for (let i = 0; i < outLen; i += 1) out[i] = input[i * step];
  } else {
    // 非整数倍（44.1k）：线性插值
    for (let i = 0; i < outLen; i += 1) {
      const pos = i * ratio;
      const lo = Math.floor(pos);
      const hi = Math.min(lo + 1, input.length - 1);
      const frac = pos - lo;
      out[i] = input[lo] * (1 - frac) + input[hi] * frac;
    }
  }
  return out;
}

/** 注册 AudioWorklet 处理器（返回是否成功）。 */
export async function registerAsrAudioWorklet(
  audioContext: AudioContext,
): Promise<boolean> {
  if (audioContext.audioWorklet === undefined) return false;
  if ((audioContext as unknown as { __asrWorkletRegistered?: boolean }).__asrWorkletRegistered) {
    return true;
  }
  // 2026-08-12（P6 真机验证）：Electron 的 Chromium 对 blob: URL 的
  // addModule 报 AbortError（即使 script-src/worker-src 已含 blob:），
  // 本地 PCM 因此永远为空 → 识别降级 text_only。改为加载同源静态文件
  // （apps/web/public/asr-capture-worklet.js，'self' 命中 script-src），
  // Electron 与浏览器（dev/prod）均验证可用。
  try {
    await audioContext.audioWorklet.addModule("/asr-capture-worklet.js");
    (audioContext as unknown as { __asrWorkletRegistered?: boolean }).__asrWorkletRegistered = true;
    return true;
  } catch {
    return false;
  }
}
