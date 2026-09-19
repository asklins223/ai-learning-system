/**
 * 伴星语音录制器（2026-09-18 接线）。
 *
 * getUserMedia 采集麦克风 → AudioWorklet 收 Float32 帧 → 渲染层内降采样到
 * 16kHz 单声道。stop 时产出：
 * - `samples`：16kHz Float32（交给本地 SenseVoice worker，可转移）；
 * - `wav`：PCM16 WAV 字节（云兜底上传用，服务端 magic-byte 校验认 RIFF/WAVE）。
 *
 * Worklet 用内联 blob 模块，避免为 30 行处理函数新增打包资产；addModule 失败
 * （极端环境）回落 ScriptProcessorNode，行为一致。
 */

export interface VoiceRecording {
  readonly sampleRate: 16000;
  readonly samples: Float32Array;
  readonly wav: ArrayBuffer;
  readonly durationMs: number;
}

export interface CompanionVoiceRecorderOptions {
  /**
   * 实时电平（RMS，0..1），约 20Hz。麦克风按钮的呼吸环与静音自动结束判定都读
   * 它；worklet 每 ~2.7ms 推一帧，所以这里做了节流，不让它牵着 React 每帧重渲。
   */
  readonly onLevel?: (level: number) => void;
}

const TARGET_SAMPLE_RATE = 16000;
const MAX_DURATION_MS = 60_000;
const LEVEL_INTERVAL_MS = 50;

/** 单帧 RMS 电平。抽成纯函数，既给回调用也便于单测。 */
export function companionVoiceLevel(chunk: Float32Array): number {
  if (chunk.length === 0) return 0;
  let sum = 0;
  for (let index = 0; index < chunk.length; index += 1) sum += chunk[index] * chunk[index];
  return Math.sqrt(sum / chunk.length);
}

const WORKLET_SOURCE = `
class CompanionTapProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length > 0) this.port.postMessage(channel.slice(0));
    return true;
  }
}
registerProcessor("companion-tap", CompanionTapProcessor);
`;

function downsampleTo16k(input: Float32Array, inputRate: number): Float32Array {
  if (inputRate === TARGET_SAMPLE_RATE) return input;
  const ratio = inputRate / TARGET_SAMPLE_RATE;
  const outputLength = Math.floor(input.length / ratio);
  const output = new Float32Array(outputLength);
  for (let i = 0; i < outputLength; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j += 1) sum += input[j];
    output[i] = end > start ? sum / (end - start) : 0;
  }
  return output;
}

function floatToPcm16(samples: Float32Array): Int16Array {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    pcm[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  return pcm;
}

function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const pcm = floatToPcm16(samples);
  const buffer = new ArrayBuffer(44 + pcm.length * 2);
  const view = new DataView(buffer);
  const writeString = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
  };
  writeString(0, "RIFF");
  view.setUint32(4, 36 + pcm.length * 2, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, pcm.length * 2, true);
  let offset = 44;
  for (let i = 0; i < pcm.length; i += 1, offset += 2) view.setInt16(offset, pcm[i], true);
  return buffer;
}

export class CompanionVoiceRecorder {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private worklet: AudioWorkletNode | null = null;
  private scriptNode: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private chunks: Float32Array[] = [];
  private totalFrames = 0;
  private startedAt = 0;
  private recording = false;
  private readonly levelListener: ((level: number) => void) | null = null;

  constructor(options?: CompanionVoiceRecorderOptions) {
    this.levelListener = options?.onLevel ?? null;
  }

  static isSupported(): boolean {
    return typeof navigator !== "undefined"
      && Boolean(navigator.mediaDevices?.getUserMedia)
      && typeof AudioContext !== "undefined";
  }

  get active(): boolean {
    return this.recording;
  }

  async start(): Promise<void> {
    if (this.recording) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.context = new AudioContext();
    await this.context.resume();
    this.source = this.context.createMediaStreamSource(this.stream);
    this.chunks = [];
    this.totalFrames = 0;
    this.startedAt = Date.now();
    let lastLevelAt = 0;
    const levelListener = this.levelListener;
    const onChunk = (chunk: Float32Array) => {
      if (!this.recording) return;
      const copy = chunk.slice(0);
      this.chunks.push(copy);
      this.totalFrames += copy.length;
      const now = Date.now();
      if (levelListener && now - lastLevelAt >= LEVEL_INTERVAL_MS) {
        lastLevelAt = now;
        levelListener(companionVoiceLevel(copy));
      }
      if (now - this.startedAt >= MAX_DURATION_MS) void this.stop();
    };
    try {
      const workletUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "application/javascript" }));
      try {
        await this.context.audioWorklet.addModule(workletUrl);
        this.worklet = new AudioWorkletNode(this.context, "companion-tap");
        this.worklet.port.onmessage = (event) => onChunk(event.data as Float32Array);
        this.source.connect(this.worklet);
        // 麦克风不进扬声器：目的地不连，仅采集。
      } finally {
        URL.revokeObjectURL(workletUrl);
      }
    } catch {
      // ScriptProcessor 兜底（已弃用但行为一致，防极端环境）。
      this.scriptNode = this.context.createScriptProcessor(4096, 1, 1);
      this.scriptNode.onaudioprocess = (event) => onChunk(event.inputBuffer.getChannelData(0));
      this.source.connect(this.scriptNode);
      this.scriptNode.connect(this.context.destination);
    }
    this.recording = true;
  }

  async stop(): Promise<VoiceRecording | null> {
    if (!this.recording) return null;
    this.recording = false;
    try { this.worklet?.disconnect(); } catch { /* already gone */ }
    try { this.scriptNode?.disconnect(); } catch { /* already gone */ }
    try { this.source?.disconnect(); } catch { /* already gone */ }
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    const sampleRate = this.context?.sampleRate ?? 48000;
    await this.context?.close().catch(() => undefined);
    this.worklet = null;
    this.scriptNode = null;
    this.source = null;
    this.stream = null;
    this.context = null;
    const durationMs = Date.now() - this.startedAt;
    if (this.totalFrames < (sampleRate * 200) / 1000) return null; // 短于 200ms 视为误触
    const merged = new Float32Array(this.totalFrames);
    let offset = 0;
    for (const chunk of this.chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    this.chunks = [];
    this.totalFrames = 0;
    const samples = downsampleTo16k(merged, sampleRate);
    return {
      sampleRate: TARGET_SAMPLE_RATE,
      samples,
      wav: encodeWav(samples, TARGET_SAMPLE_RATE),
      durationMs,
    };
  }
}
