/**
 * P6 §13：流式 TTS 播放控制器（纯逻辑 + 注入 sink，可测）。
 *
 * 职责（§13 edge-tts 流式）：
 * - 每个稳定句一条独立 HTTP 流（/voice/tts/stream），fetch 后流式读 body；
 * - 维持 segmentId + ordinal + generation；旧 generation 段（fence 已前进）丢弃；
 * - 顺序播放（队列）；当前段播放中收到新段 → 入队；
 * - 打断（barge-in）：abort 当前 fetch + sink.stop() + 清空队列 + 递增 fence；
 * - fetch/解码失败 → 该段降级（sink.onSegmentFailed，调用方回退纯文字）。
 *
 * AudioContext 等真实播放由注入的 sink 实现（Node 测试注入 mock）。
 */

export interface StreamSegment {
  runId: string;
  generation: number;
  ordinal: number;
  segmentId: string;
  text: string;
}

export interface StreamPlaybackSink {
  /** 播放一段已解码音频（返回 promise；abort 时 reject/stop） */
  play(chunk: Uint8Array, segment: StreamSegment): Promise<void>;
  /** 立即停止当前播放 */
  stop(): void;
  /** 段失败回调（降级纯文字） */
  onSegmentFailed?(segment: StreamSegment, errorCode: string): void;
  /** 段完成回调 */
  onSegmentDone?(segment: StreamSegment): void;
}

export type StreamPlaybackPhase = "idle" | "fetching" | "playing" | "barged";

export interface StreamPlaybackState {
  phase: StreamPlaybackPhase;
  fence: { runId: string; generation: number } | null;
  current: StreamSegment | null;
  queue: StreamSegment[];
}

const MAX_QUEUE = 20; // §11.3 最多 20 段

export class StreamPlaybackController {
  private state: StreamPlaybackState = {
    phase: "idle",
    fence: null,
    current: null,
    queue: [],
  };
  private activeAbort: AbortController | null = null;
  private generationCounter = 0;
  private pumpToken = 0;

  constructor(
    private readonly sink: StreamPlaybackSink,
    private readonly fetcher: (segment: StreamSegment, signal: AbortSignal) => Promise<Response>,
    private readonly gapMs = 0,
  ) {}

  snapshot(): StreamPlaybackState {
    return {
      ...this.state,
      current: this.state.current ? { ...this.state.current } : null,
      queue: this.state.queue.map((s) => ({ ...s })),
    };
  }

  /** 提交一个新句子段（旧 generation 直接丢弃） */
  enqueue(segment: StreamSegment): void {
    if (this.state.fence && (
      this.state.fence.runId !== segment.runId ||
      this.state.fence.generation !== segment.generation
    )) {
      return; // §11.5 fence：旧 run/generation 段只丢弃不播放
    }
    if (this.state.fence === null) {
      this.state.fence = { runId: segment.runId, generation: segment.generation };
    }
    if (this.state.queue.length >= MAX_QUEUE) return;
    this.state.queue.push(segment);
    void this.pump();
  }

  /** 打断：abort 当前 fetch + 停播放器 + 清队 + 递增内部 token（§11.4 barge-in）。
   *  fence 是 run 边界（runId+generation，§11.5）：打断不改变 run generation；
   *  内部 token 用于拒绝打断瞬间尚未完成的段回调（防止竞态）。 */
  bargeIn(): void {
    this.generationCounter += 1;
    const token = this.generationCounter;
    this.pumpToken = token;
    this.activeAbort?.abort();
    this.activeAbort = null;
    this.sink.stop();
    this.state.queue = [];
    this.state.current = null;
    this.state.phase = "barged";
  }

  /** 打断后恢复空闲（下一次 enqueue 自动开始） */
  clearBarged(): void {
    if (this.state.phase === "barged") this.state.phase = "idle";
  }

  private async pump(): Promise<void> {
    if (this.state.phase === "fetching" || this.state.phase === "playing") return;
    const segment = this.state.queue.shift();
    if (!segment) {
      this.state.phase = "idle";
      return;
    }
    this.state.current = segment;
    this.state.phase = "fetching";
    const controller = new AbortController();
    const token = this.pumpToken;
    this.activeAbort = controller;
    try {
      const response = await this.fetcher(segment, controller.signal);
      if (!response.ok || !response.body) {
        throw new Error(`tts_stream_${response.status}`);
      }
      this.state.phase = "playing";
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (controller.signal.aborted) break;
        if (value && value.byteLength > 0) {
          await this.sink.play(value, segment);
        }
      }
      if (controller.signal.aborted || token !== this.pumpToken) return;
      this.sink.onSegmentDone?.(segment);
      this.state.current = null;
      this.state.phase = "idle";
      // 2026-08-12（段落间隔配置）：段与段之间的额外停顿（默认 0 = 无缝），
      // 由设置 → 伴星 → 伴星语音的 segmentGapMs 控制；打断/换段时取消。
      if (this.gapMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, this.gapMs));
        if (controller.signal.aborted || token !== this.pumpToken) return;
      }
      void this.pump(); // 播下一段
    } catch (err) {
      if (controller.signal.aborted || token !== this.pumpToken) return; // 打断导致的失败不算段失败
      const code = err instanceof Error ? err.message : "tts_stream_error";
      this.sink.onSegmentFailed?.(segment, code);
      this.state.current = null;
      this.state.phase = "idle";
      void this.pump();
    } finally {
      if (this.activeAbort === controller) this.activeAbort = null;
    }
  }
}
