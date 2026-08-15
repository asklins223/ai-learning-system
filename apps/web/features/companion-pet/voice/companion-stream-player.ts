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

const MAX_QUEUE = 200; // §11.3 队列上限；2026-08-12+（15a）与 worker TTS_MAX_SEGMENTS=200 对齐（用户不要朗读上限）

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
  /** 2026-08-12+（15a-A）：最近一次出队的段，供 onDrained 回传最后一段。 */
  private lastSegment: StreamSegment | null = null;
  /** 15b（字幕般流式 TTS）：流水线预取——播放段 N 时并行发起段 N+1 的
   *  fetch（qwen 每段合成 ~0.8s 与播放并行，段间零等待）。barge-in 时
   *  abort 全部在途预取并清缓存。 */
  private prefetchCache = new Map<string, Promise<Response>>();
  private prefetchAbort = new AbortController();
  /** FN3：gapMs 段间歇定时器句柄——打断/接管时 clearTimeout，避免段播完后再
   *  多触发一次 pump（空队即 idle，但仍属多余唤醒）。 */
  private gapTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly sink: StreamPlaybackSink,
    private readonly fetcher: (segment: StreamSegment, signal: AbortSignal) => Promise<Response>,
    private readonly gapMs = 0,
    /** 2026-08-12+（15a-A）：队列全部播完（含失败降级后清空）时回调最后一段；
     *  barge-in 属主动中止，不触发。 */
    private readonly onDrained?: (lastSegment: StreamSegment) => void,
    /** 15 方案 emotion 表现层（精确版）：段音频开始播放时回调（play 首个
     *  chunk 前）——上层在此把段级情感推入 VAD。 */
    private readonly onSegmentStart?: (segment: StreamSegment) => void,
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
      // 2026-08-12+（15a-A 根因修复）：新 run（generation 递增）语音接管——
      // 更新 fence、作废旧队列、停掉旧 run 正在播的段。此前 fence 一旦锁定
      // 旧 run 就不再更新：新 run 的 voice.segments 已把 reducer 的 voice 置
      // speaking（新 run），但段被 fence 丢弃 → 不播放 → 无 onDrained →
      // voice 永久卡 speaking（"播完仍在播报"）。
      // 2026-08-13（问题1 修复）：generation 是 **per-conversation** 递增——
      // 切换对话后新 run 的 generation 可能更小（旧对话已到 6、新对话从 1
      // 开始），跨对话比较无意义。**runId 不同（新 turn/新对话）即接管**；
      // 仅同 runId 时比较 generation（重试代数）。
      if (
        this.state.fence.runId !== segment.runId ||
        segment.generation > this.state.fence.generation
      ) {
        this.generationCounter += 1; // 使旧 run 的 in-flight pump token 失效
        this.activeAbort?.abort();
        this.activeAbort = null;
        this.sink.stop();
        // FN3：接管时取消在途预取 body 与 gapMs 定时器。
        this.prefetchAbort.abort();
        this.prefetchAbort = new AbortController();
        this.clearPrefetchBodies();
        this.clearGapTimer();
        this.state.fence = { runId: segment.runId, generation: segment.generation };
        this.state.queue = [];
        this.state.current = null;
        // 2026-08-13（问题1 修复）：旧 pump 仍在飞（fetch 中）且 phase 被其
        // 占用——必须重置 phase 为 idle，新 pump 才能启动（否则段卡队列无人播）。
        this.state.phase = "idle";
        this.state.queue.push(segment); // 新 run 段入队（清空后不能丢）
        void this.pump();
        return;
      }
      return; // §11.5 fence：旧 run/generation 段只丢弃不播放
    }
    if (this.state.fence === null) {
      this.state.fence = { runId: segment.runId, generation: segment.generation };
    }
    if (this.state.queue.length >= MAX_QUEUE) return;
    this.state.queue.push(segment);
    void this.pump();
    // 15b：新段入队立即预取（播放中也能提前发起下一段 fetch，流水线）。
    this.prefetchNext();
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
    // 15b：打断时中止全部在途预取并清缓存（预取失败/过期段不播）。
    // FN3：清缓存前取消已 resolve 的 body；并取消段间歇 gapMs 定时器。
    this.prefetchAbort.abort();
    this.prefetchAbort = new AbortController();
    this.clearPrefetchBodies();
    this.clearGapTimer();
    this.sink.stop();
    this.state.queue = [];
    this.state.current = null;
    this.state.phase = "barged";
  }

  /** FN3：取消 gapMs 段间歇定时器（打断/接管/段结束后清理，避免多余 pump 唤醒）。 */
  private clearGapTimer(): void {
    if (this.gapTimer !== null) {
      clearTimeout(this.gapTimer);
      this.gapTimer = null;
    }
  }

  /** 打断后恢复空闲（下一次 enqueue 自动开始） */
  clearBarged(): void {
    if (this.state.phase === "barged") this.state.phase = "idle";
  }

  /** 15b：对队列中下一段发起预取（幂等；已缓存段跳过）。barge-in 通过
   *  prefetchAbort 中止全部在途预取。 */
  private prefetchNext(): void {
    const next = this.state.queue[0];
    if (!next) return;
    if (this.prefetchCache.has(next.segmentId)) return;
    const promise = this.fetcher(next, this.prefetchAbort.signal).catch((err) => {
      this.prefetchCache.delete(next.segmentId);
      throw err;
    });
    this.prefetchCache.set(next.segmentId, promise);
  }

  /** FN3：清空 prefetch 缓存前取消已 resolve 但 body 尚未被消费的 Response，
   *  否则响应的 body stream/底层 keep-alive 连接不回收（长会话高频打断累积）。 */
  private clearPrefetchBodies(): void {
    for (const promise of this.prefetchCache.values()) {
      // 忽略未 resolve 的（打断时会被 prefetchAbort 中止）；已 resolve 但被
      // 丢弃的 body 主动 cancel，防止连接泄漏。
      void promise.then((response) => {
        if (response && response.body) {
          // 已 resolve 且可能正被 current pump 消费：仅当本缓存条目仍是独立
          // 预取时才取消。这里统一对 body 调 cancel——若已被 pump 取走则该
          // promise 已从 cache 删除，不会重复 cancel 正在播放的流。
          void response.body.cancel();
        }
      }).catch(() => {});
    }
    // 本轮在途的预取响应若在 pump 消费期内被 cancel 会影响正常播放，因此
    // 只清空在 barge-in 时仍归本缓存、且未被 pump 取走的条目。
    this.prefetchCache.clear();
  }

  private async pump(): Promise<void> {
    if (this.state.phase === "fetching" || this.state.phase === "playing") return;
    const segment = this.state.queue.shift();
    if (!segment) {
      this.state.phase = "idle";
      // 2026-08-12+（15a-A）：队列全部播完（或失败降级后清空）→ 通知上层
      // 派发 playback_finished。barge-in 后 phase=barged 不会进入本分支；
      // 打断瞬间的 in-flight pump 由 token 校验在 132/144 行提前 return。
      if (this.lastSegment !== null) this.onDrained?.(this.lastSegment);
      return;
    }
    this.lastSegment = segment;
    this.state.current = segment;
    this.state.phase = "fetching";
    const controller = new AbortController();
    const token = this.pumpToken;
    this.activeAbort = controller;
    // 15b：播放本段的同时，预取下一段（流水线——段间零网络等待）。
    this.prefetchNext();
    try {
      // 15b：优先用预取的响应（无则现场 fetch；预取失败回退现场 fetch）。
      let response: Response;
      const prefetched = this.prefetchCache.get(segment.segmentId);
      if (prefetched) {
        this.prefetchCache.delete(segment.segmentId);
        try {
          response = await prefetched;
        } catch {
          response = await this.fetcher(segment, controller.signal);
        }
      } else {
        try {
          response = await this.fetcher(segment, controller.signal);
        } catch (firstError) {
          if (controller.signal.aborted || token !== this.pumpToken) return;
          response = await this.fetcher(segment, controller.signal);
        }
      }
      if (!response.ok || !response.body) {
        if (controller.signal.aborted || token !== this.pumpToken) return;
        const retried = await this.fetcher(segment, controller.signal);
        if (!retried.ok || !retried.body) {
          throw new Error(`tts_stream_${retried.status}`);
        }
        response = retried;
      }
      this.state.phase = "playing";
      this.onSegmentStart?.(segment);
      const body = response.body;
      if (!body) throw new Error("tts_stream_no_body");
      const reader = body.getReader();
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
        // FN3：定时器句柄存入成员，打断/接管时 clearTimeout。
        await new Promise<void>((resolve) => {
          this.gapTimer = setTimeout(() => {
            this.gapTimer = null;
            resolve();
          }, this.gapMs);
        });
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
