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

  it("discards the crashed worker so the next attempt spawns a fresh one", async () => {
    const { transcribeRecording } = await loadModule();
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
});
