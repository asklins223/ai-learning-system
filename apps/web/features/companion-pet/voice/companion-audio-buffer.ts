/**
 * P6 顺序 1：AudioWorklet capture 的 bounded buffer（纯逻辑，可测）。
 *
 * 环形缓冲语义：
 * - 固定容量（默认 16s @48k mono = 768000 samples；由构造参数决定）；
 * - push 满时丢弃最旧（保最新，采集端背压由消费端 rate 控制）；
 * - read 返回 [start, end) 的拷贝并推进读指针；允许零拷贝视图由调用方决定；
 * - 水位统计（fillRatio）供 backpressure 决策（P6 顺序 2 WSS 用）。
 */

export interface BoundedAudioBufferOptions {
  capacitySamples: number;
}

export class BoundedAudioBuffer {
  private readonly buf: Float32Array;
  private readonly capacity: number;
  private writeIdx = 0;
  private readIdx = 0;
  private filled = 0;

  constructor(opts: BoundedAudioBufferOptions) {
    if (!Number.isInteger(opts.capacitySamples) || opts.capacitySamples <= 0) {
      throw new Error("capacitySamples must be a positive integer");
    }
    this.capacity = opts.capacitySamples;
    this.buf = new Float32Array(this.capacity);
  }

  get capacitySamples(): number {
    return this.capacity;
  }

  /** 当前未读样本数（≤ capacity） */
  get availableSamples(): number {
    return this.filled;
  }

  /** 填充率 0..1（供 backpressure） */
  get fillRatio(): number {
    return this.filled / this.capacity;
  }

  /** 写入 chunk；满时丢弃最旧（返回丢弃的样本数） */
  push(chunk: Float32Array): number {
    if (chunk.length === 0) return 0;
    let dropped = 0;
    for (let i = 0; i < chunk.length; i++) {
      if (this.filled >= this.capacity) {
        // 丢最旧：读指针推进
        this.readIdx = (this.readIdx + 1) % this.capacity;
        this.filled -= 1;
        dropped += 1;
      }
      this.buf[this.writeIdx] = chunk[i];
      this.writeIdx = (this.writeIdx + 1) % this.capacity;
      this.filled += 1;
    }
    return dropped;
  }

  /** 读取至多 maxSamples 个未读样本（拷贝；返回实际读取数），推进读指针 */
  read(maxSamples: number): Float32Array {
    const n = Math.min(maxSamples, this.filled);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      out[i] = this.buf[this.readIdx];
      this.readIdx = (this.readIdx + 1) % this.capacity;
      this.filled -= 1;
    }
    return out;
  }

  /** 读取全部未读样本并清空（录音结束取整段）。 */
  readAll(): Float32Array {
    const out = this.read(this.filled);
    return out;
  }

  /** 丢弃全部未读样本 */
  clear(): void {
    this.readIdx = 0;
    this.writeIdx = 0;
    this.filled = 0;
  }
}

/**
 * 默认采集缓冲：16 秒 @48kHz 单声道（AudioWorklet 默认 context sampleRate）。
 * P6 顺序 2 的 WSS backpressure 以此水位为输入。
 */
export function defaultCaptureBuffer(
  sampleRate = 48_000,
  seconds = 16,
): BoundedAudioBuffer {
  return new BoundedAudioBuffer({ capacitySamples: sampleRate * seconds });
}
