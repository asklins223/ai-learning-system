/**
 * P6 §13：本地 SenseVoice ASR 管理器（Electron main 侧）。
 *
 * 职责：
 * - 懒创建/复用 utility process（asr-utility-worker.cjs）；
 * - probe / recognize / dispose 的转发与超时保护（probe 30s / recognize 60s，
 *   超时 kill 并重建，fail-closed）；
 * - probe 期间对 utility process 采样 working set，计算峰值内存增量
 *   （§13 Gate：utility process 峰值内存增量 ≤ 700MB）；
 * - 模型路径只从受信配置注入（显式配置或环境变量 ASR_SENSEVOICE_MODEL_DIR），
 *   renderer 无法指定任意路径。
 */

import { app, utilityProcess, type UtilityProcess } from "electron";
import * as path from "node:path";
import {
  asrProbeRequestV1Schema,
  asrWorkerRecognizeRequestV1Schema,
  type AsrModelConfigV1,
} from "@ailearn/shared";

// ─── 模型配置（受信来源） ───────────────────────────────────────────

export interface AsrModelConfigSourceV1 {
  /** model.int8.onnx 所在目录（含 tokens.txt） */
  modelDir: string;
  language?: string;
}

/**
 * 解析模型配置：优先显式传入，其次环境变量 ASR_SENSEVOICE_MODEL_DIR。
 * 不解析成功 → available=false（local_streaming 不可用，走云端/文字降级）。
 */
export function resolveAsrModelConfig(
  explicit?: AsrModelConfigSourceV1 | null,
): { available: true; config: AsrModelConfigV1 } | { available: false; reason: string } {
  const dir = explicit?.modelDir?.trim() || process.env.ASR_SENSEVOICE_MODEL_DIR?.trim();
  if (!dir) return { available: false, reason: "not-configured" };
  return {
    available: true,
    config: {
      modelPath: path.join(dir, "model.int8.onnx"),
      tokensPath: path.join(dir, "tokens.txt"),
      language: explicit?.language ?? "",
      useInverseTextNormalization: 1,
    },
  };
}

// ─── 单例管理器 ─────────────────────────────────────────────────────

interface AsrPendingRequest {
  resolve(payload: unknown): void;
  timer: ReturnType<typeof setTimeout>;
}

class AsrManager {
  private child: UtilityProcess | null = null;
  /** 按 requestId 索引的在途请求；支持 probe/recognize 并发而不互相覆盖。 */
  private pending = new Map<number, AsrPendingRequest>();
  private nextRequestId = 1;
  private baselineMemoryMB: number | null = null;
  private disposed = false;

  private ensureWorker(): { ok: true } | { ok: false; error: string } {
    if (this.child && !this.disposed) return { ok: true };
    this.disposeWorker();
    const workerPath = path.join(__dirname, "asr-utility-worker.cjs");
    try {
      const child = utilityProcess.fork(workerPath, [], {
        serviceName: "ailearn-companion-asr",
        stdio: "ignore",
        // macOS：libonnxruntime.dylib 未签名，需经 Helper (Plugin).app 加载
        //（否则 dyld 拒绝 → SIGTRAP）。发布包签名时该 Helper 会带
        // allow-unsigned-executable-memory entitlement。
        allowLoadingUnsignedLibraries: true,
      });
      this.child = child;
      child.on("message", (message: unknown) => {
        const rawRequestId = (message as { requestId?: unknown } | null)?.requestId;
        if (typeof rawRequestId !== "number") return;
        const pending = this.pending.get(rawRequestId);
        if (!pending) return;
        this.pending.delete(rawRequestId);
        clearTimeout(pending.timer);
        // 去掉内部 requestId 字段，保持下游（renderer 严格 schema）校验不变。
        const { requestId: _droppedRequestId, ...payload } =
          (message ?? {}) as { requestId?: number } & Record<string, unknown>;
        void _droppedRequestId;
        pending.resolve(payload);
      });
      child.on("exit", () => {
        this.child = null;
        // worker 退出：所有在途请求一律 fail-closed。
        const failed = this.pending;
        this.pending = new Map();
        for (const [, pending] of failed) {
          clearTimeout(pending.timer);
          pending.resolve({ version: 1, ok: false, error: "asr_worker_exited", recoverable: true });
        }
      });
      this.disposed = false;
      return { ok: true };
    } catch (err) {
      this.child = null;
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private disposeWorker(): void {
    const child = this.child;
    this.child = null;
    const pending = this.pending;
    this.pending = new Map();
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.resolve({ version: 1, ok: false, error: "asr_worker_unavailable", recoverable: true });
    }
    this.baselineMemoryMB = null;
    this.disposed = true;
    if (child) {
      try {
        child.kill();
      } catch {
        // kill 失败静默；utility process 随父进程退出清理。
      }
    }
  }

  /** probe：fork + 发送 probe + 采样内存增量（§13 Gate ≤700MB）。 */
  async probe(config: AsrModelConfigV1, testAudio: Float32Array): Promise<unknown> {
    const ensured = this.ensureWorker();
    if (!ensured.ok) {
      return { version: 1, ok: false, error: ensured.error };
    }
    const request = asrProbeRequestV1Schema.parse({
      version: 1,
      type: "probe",
      config,
      testAudio,
      sampleRate: 16000,
      warmRounds: 3,
    });
    // 基线采样必须在模型加载（worker 收到 probe 消息）之前完成。
    this.baselineMemoryMB = this.sampleMemoryMB();
    const response = await this.dispatch(request, 30_000);
    const afterMB = this.sampleMemoryMB();
    const typed = response as {
      ok?: boolean;
      probe?: { peakMemoryDeltaMB?: number };
    } | null;
    if (typed?.ok === true && typed.probe && this.baselineMemoryMB !== null && afterMB !== null) {
      typed.probe.peakMemoryDeltaMB = Math.max(0, Math.round(afterMB - this.baselineMemoryMB));
    }
    this.baselineMemoryMB = null;
    return response;
  }

  recognize(config: AsrModelConfigV1, pcm: Float32Array, sampleRate: number): Promise<unknown> {
    const ensured = this.ensureWorker();
    if (!ensured.ok) {
      return Promise.resolve({ version: 1, ok: false, error: ensured.error, recoverable: true });
    }
    const request = asrWorkerRecognizeRequestV1Schema.parse({
      version: 1,
      type: "recognize",
      config,
      pcm,
      sampleRate,
    });
    return this.dispatch(request, 60_000);
  }

  dispose(): Promise<void> {
    this.disposeWorker();
    return Promise.resolve();
  }

  private sampleMemoryMB(): number | null {
    const child = this.child;
    if (!child) return null;
    try {
      // Electron 的 process.getProcessMemoryInfo 只查当前进程；utility process
      // 的内存经 app.getAppMetrics() 按 pid 匹配（ProcessMetric.memory.workingSetSize
      // bytes，darwin/linux 有效）。
      const metric = app.getAppMetrics().find((m) => m.pid === child.pid);
      const workingSet = metric?.memory?.workingSetSize;
      if (typeof workingSet === "number") {
        return workingSet / (1024 * 1024);
      }
    } catch {
      // 采样失败不阻断。
    }
    return null;
  }

  private dispatch(request: unknown, timeoutMs: number): Promise<unknown> {
    const child = this.child;
    if (!child || this.disposed) {
      return Promise.resolve({ version: 1, ok: false, error: "asr_worker_unavailable", recoverable: true });
    }
    const requestId = this.nextRequestId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        // 仅该请求超时；若还有其他在途请求则保留 worker，避免误杀并发调用。
        if (this.pending.delete(requestId)) {
          resolve({ version: 1, ok: false, error: "asr_worker_timeout", recoverable: true });
        }
        if (this.pending.size === 0) {
          this.disposeWorker();
        }
      }, timeoutMs);
      this.pending.set(requestId, { resolve, timer });
      try {
        child.postMessage({ ...(request as Record<string, unknown>), requestId });
      } catch {
        clearTimeout(timer);
        this.pending.delete(requestId);
        resolve({ version: 1, ok: false, error: "asr_post_message_failed", recoverable: true });
      }
    });
  }
}

export const asrManager = new AsrManager();
