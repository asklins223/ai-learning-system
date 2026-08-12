/**
 * P6 §13：sherpa-onnx native SenseVoice 集成层（Electron 客户端本地 ASR）。
 *
 * - 用 sherpa-onnx 的 createOfflineRecognizer（modelType: sense-voice），
 *   识别器工厂可注入（Node 测试 mock；Electron 注入真实 sherpa-onnx）；
 * - SenseVoice 是离线模型，准流式 = VAD 切段 + 每段离线识别（与 P3 非流式语义对齐）；
 * - 模型运行时加载（首次下载缓存 ~250MB int8），不打包进应用；
 * - 性能探测（companion-asr-probe-runner）用内置 3–5s 测试音频跑真实模型，
 *   测冷启动 / warm RTF / 峰值内存增量（合同 Gate）。
 */

export interface SenseVoiceModelConfig {
  /** model.int8.onnx 绝对路径（Electron userData 缓存目录） */
  modelPath: string;
  /** tokens.txt 绝对路径 */
  tokensPath: string;
  /** 识别语言：zh（默认）/ auto */
  language?: string;
}

export interface OfflineRecognizerLike {
  createStream(): {
    acceptWaveform(sampleRate: number, samples: Float32Array): void;
    free?: () => void;
  };
  decode(stream: unknown): void;
  getResult(stream: unknown): { text: string };
  free?: () => void;
}

export interface SenseVoiceFactory {
  createOfflineRecognizer(config: unknown): OfflineRecognizerLike;
}

export interface RecognizeInput {
  /** 16kHz 单声道 Float32 PCM */
  pcm: Float32Array;
}

export interface RecognizeResult {
  text: string;
  elapsedMs: number;
}

/**
 * 构建 sherpa-onnx 离线识别器配置（sense-voice）。
 * config 形状与 sherpa-onnx 的 OfflineRecognizerConfig 对齐。
 */
export function buildSenseVoiceConfig(cfg: SenseVoiceModelConfig): unknown {
  return {
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      // sherpa-onnx keeps the vocabulary on OfflineModelConfig, not on the
      // SenseVoice-specific sub-config. Putting it under senseVoice makes the
      // native config look valid but leaves the required top-level tokens
      // pointer empty.
      tokens: cfg.tokensPath,
      provider: "cpu",
      debug: 0,
      senseVoice: {
        model: cfg.modelPath,
        language: cfg.language ?? "zh",
        useInverseTextNormalization: true,
      },
    },
  };
}

export class SenseVoiceLocalRecognizer {
  private recognizer: OfflineRecognizerLike | null = null;

  constructor(
    private readonly factory: SenseVoiceFactory,
    private readonly config: SenseVoiceModelConfig,
  ) {}

  /** 冷启动：加载模型（返回加载耗时 ms） */
  async load(): Promise<number> {
    this.dispose();
    const startedAt = performance.now();
    this.recognizer = this.factory.createOfflineRecognizer(buildSenseVoiceConfig(this.config));
    return Math.round(performance.now() - startedAt);
  }

  get loaded(): boolean {
    return this.recognizer !== null;
  }

  /** 识别一段 16kHz PCM（warm：不含模型加载） */
  recognize(input: RecognizeInput): RecognizeResult {
    if (!this.recognizer) {
      throw new Error("recognizer_not_loaded");
    }
    if (input.pcm.length === 0) {
      throw new Error("empty_pcm");
    }
    const startedAt = performance.now();
    const stream = this.recognizer.createStream();
    try {
      stream.acceptWaveform(16000, input.pcm);
      this.recognizer.decode(stream);
      const text = this.recognizer.getResult(stream).text.trim();
      return { text, elapsedMs: Math.round(performance.now() - startedAt) };
    } finally {
      // Offline streams own native memory. Releasing each segment is required
      // for the VAD/准流式 path, otherwise a long session grows unbounded.
      stream.free?.();
    }
  }

  /** 释放（Electron 退出/降级时调用） */
  dispose(): void {
    this.recognizer?.free?.();
    this.recognizer = null;
  }
}
