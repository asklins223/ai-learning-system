/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 本地 ASR 路由的失败路径（2026-09-19）。
 *
 * 这一层最贵的错法是「安静地慢」：worker 脚本加载失败时只走 onerror，不会发
 * ready/fatal 消息，于是 init 要等满 60 秒超时，用户点完「说完了」白等一分钟才
 * 落到云通道。这里锁住两件事——崩溃即刻回落，以及死掉的 worker 不被复用。
 */

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly posted: Array<Record<string, unknown>> = [];
  terminated = false;

  constructor(readonly url: string) {
    FakeWorker.instances.push(this);
  }

  postMessage(data: Record<string, unknown>): void {
    this.posted.push(data);
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent);
  }

  failLoad(): void {
    this.onerror?.();
  }
}

function stubRuntime(): void {
  FakeWorker.instances = [];
  vi.stubGlobal("Worker", FakeWorker);
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true })));
  vi.resetModules();
}

async function loadModule() {
  return import("./local-speech-recognition");
}

const args = (transcribeViaCloud: () => Promise<{ text: string; voiceArtifactId: string }>) => ({
  sampleRate: 16_000,
  samples: new Float32Array(1_600),
  wav: new ArrayBuffer(8),
  durationMs: 300,
  transcribeViaCloud,
});

describe("local speech recognition routing", () => {
  beforeEach(stubRuntime);
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("falls back to the cloud route immediately when the worker fails to load", async () => {
    const { transcribeRecording } = await loadModule();
    const cloud = vi.fn(async () => ({ text: "云端结果", voiceArtifactId: "va-1" }));
    const started = Date.now();
    const pending = transcribeRecording(args(cloud));

    await vi.waitFor(() => expect(FakeWorker.instances).toHaveLength(1));
    FakeWorker.instances[0]!.failLoad();

    const result = await pending;
    expect(result).toEqual({ text: "云端结果", route: "cloud", voiceArtifactId: "va-1" });
    expect(cloud).toHaveBeenCalledTimes(1);
    // 60s 的 init 超时意味着这里会挂满一分钟；崩溃必须当场打断它。
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("discards the crashed worker so the next attempt spawns a fresh one", async () => {    const { transcribeRecording } = await loadModule();
    const cloud = vi.fn(async () => ({ text: "云端", voiceArtifactId: "va-2" }));

    const first = transcribeRecording(args(cloud));
    await vi.waitFor(() => expect(FakeWorker.instances).toHaveLength(1));
    const dead = FakeWorker.instances[0]!;
    dead.failLoad();
    await first;
    expect(dead.terminated).toBe(true);

    const second = transcribeRecording(args(cloud));
    await vi.waitFor(() => expect(FakeWorker.instances).toHaveLength(2));
    const live = FakeWorker.instances[1]!;
    live.emit({ type: "ready" });

    await vi.waitFor(() => expect(live.posted.some((message) => message.type === "decode")).toBe(true));
    const decode = live.posted.find((message) => message.type === "decode")!;
    live.emit({ type: "result", id: decode.id, text: "本地结果" });

    await expect(second).resolves.toEqual({ text: "本地结果", route: "local", voiceArtifactId: null });
    expect(cloud).toHaveBeenCalledTimes(1);
  });

  /**
   * 空闲下线（2026-09-22 性能重扫 H6）。
   *
   * 这一层以前只有崩溃才 `terminate`：本地 SenseVoice 一份引擎就是那份 228 MB 的 int8
   * 模型，用户说过一句话之后它就一直占到应用退出——而语音是偶尔用的。这里锁两件事：
   * 空闲窗口到点必须下线，且再说一句要能重新拉起（不能下线之后就永久坏掉）。
   */
  it("releases the engine after the idle window and re-spawns for the next utterance", async () => {
    vi.useFakeTimers();
    try {
      const flush = async (ms = 0) => {
        await vi.advanceTimersByTimeAsync(ms);
      };
      const { transcribeRecording } = await loadModule();
      const cloud = vi.fn(async () => ({ text: "云端", voiceArtifactId: "va-3" }));

      const first = transcribeRecording(args(cloud));
      await flush();
      expect(FakeWorker.instances).toHaveLength(1);
      const worker = FakeWorker.instances[0]!;
      worker.emit({ type: "ready" });
      await flush();
      const decode = worker.posted.find((message) => message.type === "decode");
      expect(decode).toBeTruthy();
      worker.emit({ type: "result", id: decode!.id, text: "本地结果" });
      await expect(first).resolves.toMatchObject({ text: "本地结果", route: "local" });
      expect(worker.terminated).toBe(false);

      // 差一秒不收：说明这条线是"空闲"而不是"用完即弃"，连说几句不用重载模型。
      await flush(89_000);
      expect(worker.terminated).toBe(false);
      await flush(90_000 - 89_000 + 1_000);
      expect(worker.terminated).toBe(true);

      const second = transcribeRecording(args(cloud));
      await flush();
      expect(FakeWorker.instances).toHaveLength(2);
      const next = FakeWorker.instances[1]!;
      expect(next).not.toBe(worker);
      next.emit({ type: "ready" });
      await flush();
      const nextDecode = next.posted.find((message) => message.type === "decode");
      expect(nextDecode).toBeTruthy();
      next.emit({ type: "result", id: nextDecode!.id, text: "第二句" });
      await expect(second).resolves.toMatchObject({ text: "第二句", route: "local" });
      expect(cloud).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
