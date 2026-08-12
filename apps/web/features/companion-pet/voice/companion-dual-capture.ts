/**
 * P6 §13：双路径录音控制器（纯逻辑 + 注入 sink，可测）。
 *
 * - AudioWorklet PCM 喂本地识别（local stream）；
 * - MediaRecorder 保存有界压缩副本（bounded：时长/大小上限，超限丢弃最旧）；
 * - 结束：本地识别成功 → 立即丢弃副本（零上传）；本地失败 → 标记待上传；
 * - 上传前一次性明确告知（consent 持久化）；未同意 → 不静默上传（text_only）；
 * - API Key 留服务端：上传走 api（POST /voice/transcribe），Electron 不持有 key。
 */

export type DualCapturePhase = "idle" | "recording" | "finalizing" | "uploading" | "discarded" | "failed";

export interface DualCaptureState {
  phase: DualCapturePhase;
  /** MediaRecorder 副本已收集的字节数（bounded） */
  recordingBytes: number;
  /** 本地 ASR 是否成功（成功 → 丢弃副本） */
  localSucceeded: boolean | null;
  /** 是否允许上传（已一次性告知） */
  uploadConsented: boolean;
  /** 待上传副本引用（服务端 session 上传用） */
  pendingUploadRef: string | null;
}

export const BOUNDED_RECORDING_LIMIT = Object.freeze({
  maxSeconds: 60,
  maxBytes: 5 * 1024 * 1024, // 5MB 压缩副本上限
});

export interface DualCaptureSink {
  /** 收到 MediaRecorder 分块（有界收集） */
  onRecorderChunk(bytes: number): void;
  /** 本地识别成功（副本可丢弃） */
  onLocalSuccess(): void;
  /** 本地识别失败（副本待上传；若已同意） */
  onLocalFailure(): void;
  /** 请求上传（返回上传是否发起；由调用方走 api） */
  upload(ref: string): Promise<boolean>;
}

export class DualCaptureController {
  private state: DualCaptureState = {
    phase: "idle",
    recordingBytes: 0,
    localSucceeded: null,
    uploadConsented: false,
    pendingUploadRef: null,
  };
  private recordedSeconds = 0;

  constructor(
    private readonly sink: DualCaptureSink,
    private readonly now: () => number = Date.now,
  ) {}

  snapshot(): DualCaptureState {
    return { ...this.state };
  }

  /** 一次性告知同意（持久化由调用方存设置） */
  setUploadConsent(consented: boolean): void {
    this.state.uploadConsented = consented;
  }

  startRecording(): void {
    this.state = {
      ...this.state,
      phase: "recording",
      recordingBytes: 0,
      localSucceeded: null,
      pendingUploadRef: null,
    };
    this.recordedSeconds = 0;
  }

  /** AudioWorklet PCM chunk 喂本地识别（此处只计时/统计，不涉及 PCM 内容） */
  onLocalPcmChunk(seconds: number): void {
    this.recordedSeconds += seconds;
  }

  /** 本地识别成功（副本可丢弃） */
  onLocalSuccess(): void {
    this.state.localSucceeded = true;
    this.sink.onLocalSuccess();
  }

  /** 本地识别失败（副本待上传；若已告知） */
  onLocalFailure(): void {
    this.state.localSucceeded = false;
    this.sink.onLocalFailure();
  }

  /** MediaRecorder 副本分块（有界：超 maxSeconds/maxBytes → 丢弃最旧并截断） */
  onRecorderChunk(bytes: number): void {
    this.state.recordingBytes += bytes;
    // 有界：超限时丢弃最旧（滚动窗口）
    const overBytes = this.state.recordingBytes - BOUNDED_RECORDING_LIMIT.maxBytes;
    if (overBytes > 0) this.state.recordingBytes = BOUNDED_RECORDING_LIMIT.maxBytes;
    if (this.recordedSeconds > BOUNDED_RECORDING_LIMIT.maxSeconds) {
      this.state.recordingBytes = 0; // 超时长 → 截断（副本仅保留最新窗口由调用方实现）
    }
    this.sink.onRecorderChunk(bytes);
  }

  async finish(): Promise<void> {
    this.state.phase = "finalizing";
    if (this.state.localSucceeded) {
      // 本地成功 → 立即丢弃副本（零上传）
      this.state.phase = "discarded";
      this.state.recordingBytes = 0;
      this.state.pendingUploadRef = null;
      return;
    }
    // 本地失败 → 待上传（需已一次性告知）
    if (!this.state.uploadConsented || this.state.recordingBytes <= 0) {
      this.state.phase = "failed";
      this.state.pendingUploadRef = null;
      return;
    }
    const ref = `recording:${this.now()}`;
    this.state.pendingUploadRef = ref;
    this.state.phase = "uploading";
    const ok = await this.sink.upload(ref);
    if (ok) {
      this.state.phase = "discarded";
      this.state.recordingBytes = 0;
      this.state.pendingUploadRef = null;
    } else {
      this.state.phase = "failed";
      this.state.pendingUploadRef = ref;
    }
  }
}
