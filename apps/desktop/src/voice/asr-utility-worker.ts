/**
 * P6 §13：本地 SenseVoice ASR utility process（sherpa-onnx-node native）。
 *
 * 拓扑：main 用 `utilityProcess.fork` 启动本脚本；renderer 经 typed preload
 * IPC → main → `child.postMessage` → 本 worker。消息协议见
 * `@ailearn/shared/companion-asr-contracts`。
 *
 * - sherpa-onnx-node 是 native addon（esbuild external），运行时从
 *   node_modules 解析；模型文件（model.int8.onnx + tokens.txt）由 main 从
 *   受信配置注入路径，不打包进应用；
 * - 懒加载：首次 probe/recognize 时创建 recognizer（冷启动计入门内）；
 * - 识别输入为 16kHz mono Float32Array（AudioWorklet 采集 → IPC 结构化克隆）；
 * - 任何失败都以 `{ ok: false, error, recoverable }` 返回，绝不让 worker
 *   崩溃拖垮 utility process。
 */

// ─── Types ──────────────────────────────────────────────────────────

interface ParentPortLike {
  // Electron utility process 的 parentPort 消息事件是 { data } 包装
  // （见 web-worker.ts 先例）。
  on(event: "message", listener: (event: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
}

interface WorkerProcessLike {
  parentPort?: ParentPortLike;
}

declare const workerProcess: WorkerProcessLike;

interface AsrModelConfigV1 {
  modelPath: string;
  tokensPath: string;
  language?: string;
  useInverseTextNormalization?: number;
}

interface ProbeMessage {
  version: 1;
  type: "probe";
  requestId: number;
  config: AsrModelConfigV1;
  testAudio: Float32Array;
  sampleRate: number;
  warmRounds: number;
}

interface RecognizeMessage {
  version: 1;
  type: "recognize";
  requestId: number;
  config: AsrModelConfigV1;
  pcm: Float32Array;
  sampleRate: number;
}

interface DisposeMessage {
  version: 1;
  type: "dispose";
}

type WorkerMessage = ProbeMessage | RecognizeMessage | DisposeMessage;

interface OfflineStreamLike {
  acceptWaveform(obj: { sampleRate: number; samples: Float32Array }): void;
  free?(): void;
}
interface OfflineRecognizerLike {
  createStream(): OfflineStreamLike;
  decode(stream: OfflineStreamLike): void;
  getResult(stream: OfflineStreamLike): { text: string };
  free?(): void;
}

// ─── sherpa-onnx-node 加载 ──────────────────────────────────────────

// CJS bundle（esbuild format: cjs）：直接使用全局 require；
// sherpa-onnx-node 被 esbuild external，运行时从 node_modules 解析 native addon。

interface SherpaOnnxModule {
  OfflineRecognizer: new (config: unknown) => OfflineRecognizerLike;
  // 注意：readWave 在 Electron ABI 下抛 "External buffers are not allowed"，
  // 一律不使用——PCM 由调用方（AudioWorklet）直接提供 Float32Array。
}

function loadSherpaOnnx(): SherpaOnnxModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    return require("sherpa-onnx-node") as SherpaOnnxModule;
  } catch {
    return null;
  }
}

function buildSenseVoiceConfig(config: AsrModelConfigV1): unknown {
  return {
    modelConfig: {
      senseVoice: {
        model: config.modelPath,
        language: config.language ?? "",
        useInverseTextNormalization: config.useInverseTextNormalization ?? 1,
      },
      tokens: config.tokensPath,
    },
  };
}

// ─── recognizer 生命周期 ────────────────────────────────────────────

let sherpa: SherpaOnnxModule | null = null;
let recognizer: OfflineRecognizerLike | null = null;
let loadedConfigKey: string | null = null;

function configKey(config: AsrModelConfigV1): string {
  return `${config.modelPath}|${config.tokensPath}|${config.language ?? ""}`;
}

function ensureRecognizer(config: AsrModelConfigV1): {
  ok: true; coldStartMs: number;
} | { ok: false; error: string } {
  const key = configKey(config);
  if (recognizer && loadedConfigKey === key) return { ok: true, coldStartMs: 0 };
  disposeRecognizer();
  sherpa ??= loadSherpaOnnx();
  if (!sherpa) {
    return { ok: false, error: "sherpa-onnx-node 加载失败（native addon 缺失）" };
  }
  const startedAt = performance.now();
  try {
    recognizer = new sherpa.OfflineRecognizer(buildSenseVoiceConfig(config));
    loadedConfigKey = key;
    return { ok: true, coldStartMs: Math.round(performance.now() - startedAt) };
  } catch (err) {
    recognizer = null;
    loadedConfigKey = null;
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function disposeRecognizer(): void {
  try {
    recognizer?.free?.();
  } catch {
    // free 失败不影响进程；后续加载会重建。
  }
  recognizer = null;
  loadedConfigKey = null;
}

function recognizePcm(
  pcm: Float32Array,
  sampleRate: number,
): { ok: true; text: string; elapsedMs: number } | { ok: false; error: string } {
  if (!recognizer) return { ok: false, error: "recognizer_not_loaded" };
  if (pcm.length === 0) return { ok: false, error: "empty_pcm" };
  const startedAt = performance.now();
  try {
    const stream = recognizer.createStream();
    try {
      stream.acceptWaveform({ sampleRate, samples: pcm });
      recognizer.decode(stream);
      const text = recognizer.getResult(stream).text.trim();
      return { ok: true, text, elapsedMs: Math.round(performance.now() - startedAt) };
    } finally {
      stream.free?.();
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * probe 专用：只测量前向耗时，容忍空文本——性能探测的测试音频是内置
 * 3–5s 音频（可能为静音/音调，SenseVoice 对无语音输入返回空 transcript），
 * RTF 测量只关心模型前向耗时，空文本不算崩溃（与正常识别路径区分）。
 */
function probeRecognizeElapsed(
  pcm: Float32Array,
  sampleRate: number,
): { ok: true; elapsedMs: number } | { ok: false; error: string } {
  if (!recognizer) return { ok: false, error: "recognizer_not_loaded" };
  const startedAt = performance.now();
  try {
    const stream = recognizer.createStream();
    try {
      stream.acceptWaveform({ sampleRate, samples: pcm });
      recognizer.decode(stream);
      void recognizer.getResult(stream);
      return { ok: true, elapsedMs: Math.round(performance.now() - startedAt) };
    } finally {
      stream.free?.();
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ─── 消息处理 ───────────────────────────────────────────────────────

function handleProbe(message: ProbeMessage): unknown {
  const loaded = ensureRecognizer(message.config);
  if (!loaded.ok) {
    return {
      version: 1,
      ok: false,
      requestId: message.requestId,
      error: loaded.error,
    };
  }
  const audioSeconds = message.testAudio.length / message.sampleRate;
  let maxRtf = 0;
  let slowWindows = 0;
  let crashed = false;
  for (let i = 0; i < message.warmRounds; i += 1) {
    const result = probeRecognizeElapsed(message.testAudio, message.sampleRate);
    if (!result.ok) {
      crashed = true;
      break;
    }
    const rtf = audioSeconds > 0 ? result.elapsedMs / (audioSeconds * 1000) : -1;
    maxRtf = Math.max(maxRtf, rtf);
    if (rtf > 0.8) slowWindows += 1;
  }
  return {
    version: 1,
    ok: true,
    requestId: message.requestId,
    probe: {
      coldStartMs: loaded.coldStartMs,
      warmRtf: Math.round(maxRtf * 100) / 100,
      peakMemoryDeltaMB: 0, // 真实增量由 main 侧进程内存采样补充
      modelCrashed: crashed,
      sustainedSlow: slowWindows >= 2,
      modelLoadFailed: !loaded.ok,
    },
  };
}

function handleRecognize(message: RecognizeMessage): unknown {
  const loaded = ensureRecognizer(message.config);
  if (!loaded.ok) {
    return { version: 1, ok: false, requestId: message.requestId, error: loaded.error, recoverable: true };
  }
  const result = recognizePcm(message.pcm, message.sampleRate);
  if (!result.ok) {
    return { version: 1, ok: false, requestId: message.requestId, error: result.error, recoverable: true };
  }
  return {
    version: 1,
    ok: true,
    requestId: message.requestId,
    text: result.text,
    elapsedMs: result.elapsedMs,
  };
}

// ─── 入口 ───────────────────────────────────────────────────────────

// utility process 提供 process.parentPort（Electron augmentation）；为避开
// DOM 全局 `parent` 与 Node 全局 `process` 的类型冲突，经窄接口访问。
const parentPort = (process as unknown as WorkerProcessLike).parentPort;
if (!parentPort) {
  // 非 utility process 环境（直接 node 运行）——保持进程存活仅用于调试。
  // 正常路径由 Electron utilityProcess 注入 parentPort。
  // eslint-disable-next-line no-console
  console.warn("[asr-worker] no process.parentPort; running in standalone debug mode");
} else {
  parentPort.on("message", (event: { data: unknown }) => {
    const message = event.data as WorkerMessage;
    let response: unknown;
    try {
      switch (message?.type) {
        case "probe":
          response = handleProbe(message);
          break;
        case "recognize":
          response = handleRecognize(message);
          break;
        case "dispose":
          disposeRecognizer();
          response = { version: 1, ok: true };
          break;
        default:
          response = { version: 1, ok: false, error: "unknown_asr_message", recoverable: true };
      }
    } catch (err) {
      response = {
        version: 1,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        recoverable: true,
      };
    }
    try {
      parentPort.postMessage(response);
    } catch {
      // 父进程已退出——静默。
    }
  });
  // 保持进程存活（utility process 默认不会自动退出）。
}
