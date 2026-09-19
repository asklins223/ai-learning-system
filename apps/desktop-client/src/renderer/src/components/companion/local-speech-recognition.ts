/**
 * 伴星本地语音识别路由层（2026-09-18 接线）。
 *
 * 第一路由：本地 SenseVoice（sherpa-onnx WASM，`/sherpa/asr-worker.js`）——
 * 音频不出设备；worker 拉起失败、模型缺失或识别失败时落第二路由：云通道
 * `POST /voice/transcribe`（SiliconFlow，服务端会签发 voiceArtifactId）。
 * 降级顺序与 docs/plans/learning-companion/13-… §P6 的三路由设计一致。
 */

export type VoiceRoute = "local" | "cloud";

export interface VoiceTranscription {
  readonly text: string;
  readonly route: VoiceRoute;
  /** 云通道回执；本地路由没有服务端 artifact。 */
  readonly voiceArtifactId: string | null;
}

interface DecodePending {
  resolve: (text: string) => void;
  reject: (err: Error) => void;
}

let worker: Worker | null = null;
let initPromise: Promise<void> | null = null;
/** 正在等待 ready/fatal 的那次 init 的 reject；worker 崩了要立刻打断它。 */
let initReject: ((error: Error) => void) | null = null;
const pending = new Map<number, DecodePending>();
let decodeSeq = 0;

function spawnWorker(): Worker | null {
  if (worker) return worker;
  try {
    worker = new Worker("/sherpa/asr-worker.js");
  } catch {
    worker = null;
    return null;
  }
  worker.onmessage = (event: MessageEvent) => {
    const data = event.data || {};
    if (data.type === "ready" || data.type === "fatal") {
      // ready/fatal 由 init 的 await 链消费（worker 里的 promise 会 resolve/reject）。
      return;
    }
    if ((data.type === "result" || data.type === "error") && typeof data.id === "number") {
      const entry = pending.get(data.id);
      pending.delete(data.id);
      if (!entry) return;
      if (data.type === "result") entry.resolve(String(data.text ?? ""));
      else entry.reject(new Error(String(data.message ?? "decode failed")));
    }
  };
  worker.onerror = () => {
    // 加载失败（文件缺失等）：让 init 与在途解码立刻失败，后续走云通道。
    // 不等 init 的 60s 超时——那会让用户点完「说完了」白等一分钟。
    for (const [, entry] of pending) entry.reject(new Error("asr worker crashed"));
    pending.clear();
    initReject?.(new Error("asr worker crashed"));
    // 死掉的 worker 不能复用：留着它下一次识别只会再撞一次同样的错。
    worker?.terminate();
    worker = null;
    initPromise = null;
  };
  return worker;
}

async function initLocalEngine(): Promise<void> {
  if (initPromise) return initPromise;
  const w = spawnWorker();
  if (!w) throw new Error("worker unavailable");
  initPromise = new Promise<void>((resolve, reject) => {
    const previous = w.onmessage;
    const previousError = w.onerror;
    const settle = () => {
      window.clearTimeout(timeout);
      w.onmessage = previous;
      w.onerror = previousError;
      initReject = null;
    };
    const timeout = window.setTimeout(() => {
      settle();
      initPromise = null;
      reject(new Error("asr init timeout"));
    }, 60_000);
    initReject = (error) => {
      settle();
      initPromise = null;
      reject(error);
    };
    w.onmessage = (event: MessageEvent) => {
      const data = event.data || {};
      if (data.type === "ready") {
        settle();
        resolve();
      } else if (data.type === "fatal") {
        settle();
        initPromise = null;
        reject(new Error(String(data.message ?? "asr init failed")));
      }
    };
    w.postMessage({ type: "init" });
  });
  try {
    await initPromise;
  } catch (err) {
    initPromise = null;
    throw err;
  }
}

async function decodeLocally(sampleRate: number, samples: Float32Array): Promise<string> {
  await initLocalEngine();
  const w = spawnWorker();
  if (!w) throw new Error("worker unavailable");
  const id = ++decodeSeq;
  return new Promise<string>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      pending.delete(id);
      reject(new Error("asr decode timeout"));
    }, 30_000);
    pending.set(id, {
      resolve: (text) => {
        window.clearTimeout(timeout);
        resolve(text);
      },
      reject: (err) => {
        window.clearTimeout(timeout);
        reject(err);
      },
    });
    w.postMessage({ type: "decode", id, sampleRate, samples }, [samples.buffer]);
  });
}

/** 本地引擎是否值得一试：探测模型清单文件是否存在（HEAD，不下载 239MB）。 */
export async function probeLocalAsrModel(): Promise<boolean> {
  try {
    const response = await fetch("/models/asr/tokens.txt", { method: "HEAD" });
    return response.ok;
  } catch {
    return false;
  }
}

export interface TranscribeArgs {
  readonly sampleRate: number;
  readonly samples: Float32Array;
  readonly wav: ArrayBuffer;
  readonly durationMs: number;
  /** 云兜底：走 `window.ailearn.companion.voice.transcribe`（main → SiliconFlow）。 */
  readonly transcribeViaCloud: () => Promise<{ text: string; voiceArtifactId: string }>;
}

export async function transcribeRecording(args: TranscribeArgs): Promise<VoiceTranscription> {
  if (await probeLocalAsrModel()) {
    try {
      const text = await decodeLocally(args.sampleRate, args.samples);
      if (text.length > 0) return { text, route: "local", voiceArtifactId: null };
    } catch {
      // 本地失败 → 云兜底，不打断用户。
    }
  }
  const cloud = await args.transcribeViaCloud();
  return { text: cloud.text, route: "cloud", voiceArtifactId: cloud.voiceArtifactId };
}
