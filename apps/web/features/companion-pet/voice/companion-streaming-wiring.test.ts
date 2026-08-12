import test from "node:test";
import assert from "node:assert/strict";
import { downsampleTo16k } from "./companion-audio-worklet.ts";
import { createDualCaptureRuntime } from "./companion-dual-capture-runtime.ts";
import { createStreamingAsrRuntime } from "./companion-streaming-asr-runtime.ts";
import { BoundedAudioBuffer } from "./companion-audio-buffer.ts";
import { createLocalAsrClient } from "./companion-asr-client.ts";

// ─── downsample ─────────────────────────────────────────────────────

test("downsampleTo16k：48k 3:1 整数下采样", () => {
  const input = new Float32Array(48);
  for (let i = 0; i < 48; i += 1) input[i] = i;
  const out = downsampleTo16k(input, 48000);
  assert.equal(out.length, 16);
  assert.equal(out[0], 0);
  assert.equal(out[1], 3);
  assert.equal(out[15], 45);
});

test("downsampleTo16k：16k 原样返回", () => {
  const input = new Float32Array(160);
  input[5] = 0.5;
  const out = downsampleTo16k(input, 16000);
  assert.equal(out, input);
});

test("downsampleTo16k：44.1k 非整数倍线性插值", () => {
  const input = new Float32Array(44100);
  input.fill(1);
  const out = downsampleTo16k(input, 44100);
  assert.equal(out.length, Math.floor(44100 / 2.75625));
  // 全 1 的插值结果应保持 1（±1e-6）
  assert.ok(Math.abs(out[100] - 1) < 1e-6);
});

// ─── BoundedAudioBuffer.readAll ─────────────────────────────────────

test("BoundedAudioBuffer.readAll 返回全部并清空", () => {
  const buf = new BoundedAudioBuffer({ capacitySamples: 100 });
  buf.push(new Float32Array([1, 2, 3]));
  const all = buf.readAll();
  assert.deepEqual(Array.from(all), [1, 2, 3]);
  assert.equal(buf.availableSamples, 0);
});

// ─── dual capture runtime（注入 audioContext stub） ─────────────────

test("createDualCaptureRuntime：worklet 注册失败时 start 返回 false（降级路径）", async () => {
  const runtime = createDualCaptureRuntime({
    audioContext: {
      sampleRate: 48000,
      createMediaStreamSource: () => ({ connect: () => undefined, disconnect: () => undefined }),
      audioWorklet: { addModule: async () => { throw new Error("no worklet"); } },
    } as unknown as AudioContext,
    mediaStream: {} as MediaStream,
  });
  const ok = await runtime.start();
  assert.equal(ok, false);
});

// ─── streaming ASR 三路由 ───────────────────────────────────────────

const STATIC_OK = {
  arch: "arm64" as const,
  logicalCores: 8,
  totalMemoryGB: 16,
  availableMemoryGB: 8,
  freeDiskGB: 20,
  nativeRuntimeLoadable: true,
  modelHashValid: true,
};

function baseDeps(overrides: Partial<Parameters<typeof createStreamingAsrRuntime>[0]> = {}) {
  return {
    getCapability: async () => ({ available: true }),
    probe: async () => ({ ok: true as const, probe: { coldStartMs: 500, warmRtf: 0.05 } }),
    recognize: async () => ({ ok: true as const, text: "本地识别结果" }),
    uploadToCloud: async () => ({ ok: true as const, text: "云端识别结果" }),
    staticInput: STATIC_OK,
    siliconFlowAvailable: true,
    userConsentedCloud: true,
    testAudio: new Float32Array(16000 * 3),
    ...overrides,
  };
}

test("streaming ASR：探测通过 → local_streaming 本地识别", async () => {
  let recognizeCalled = false;
  const runtime = createStreamingAsrRuntime(baseDeps({
    recognize: async () => { recognizeCalled = true; return { ok: true as const, text: "本地" }; },
  }));
  const outcome = await runtime.transcribe(new Float32Array(16000), null);
  assert.equal(outcome.kind, "transcript");
  assert.equal(recognizeCalled, true);
  if (outcome.kind === "transcript") assert.equal(outcome.source, "local");
});

test("streaming ASR：probe 失败 → siliconflow_file 云端上传", async () => {
  let uploadCalled = false;
  const runtime = createStreamingAsrRuntime(baseDeps({
    probe: async () => ({ ok: false as const, error: "model_load_failed" }),
    uploadToCloud: async () => { uploadCalled = true; return { ok: true as const, text: "云端" }; },
  }));
  const outcome = await runtime.transcribe(new Float32Array(16000), new Blob(["x"]));
  assert.equal(outcome.kind, "transcript");
  assert.equal(uploadCalled, true);
  if (outcome.kind === "transcript") assert.equal(outcome.source, "cloud");
});

test("streaming ASR：本地不可用且云端未同意 → text_only", async () => {
  const runtime = createStreamingAsrRuntime(baseDeps({
    probe: async () => ({ ok: false as const, error: "model_load_failed" }),
    siliconFlowAvailable: false,
    userConsentedCloud: false,
  }));
  const outcome = await runtime.transcribe(new Float32Array(16000), null);
  assert.equal(outcome.kind, "text_only");
});

test("streaming ASR：本地识别失败 → 降级云端", async () => {
  let uploadCalled = false;
  const runtime = createStreamingAsrRuntime(baseDeps({
    recognize: async () => ({ ok: false as const, error: "ASR_FAILED", recoverable: true }),
    uploadToCloud: async () => { uploadCalled = true; return { ok: true as const, text: "云端兜底" }; },
  }));
  const outcome = await runtime.transcribe(new Float32Array(16000), new Blob(["x"]));
  assert.equal(outcome.kind, "transcript");
  assert.equal(uploadCalled, true);
});

test("streaming ASR：静态兼容不过 → 直接云端（不跑 probe）", async () => {
  let probeCalled = false;
  const runtime = createStreamingAsrRuntime(baseDeps({
    staticInput: { ...STATIC_OK, logicalCores: 2, arch: "other" },
    probe: async () => { probeCalled = true; return { ok: true as const, probe: { coldStartMs: 1, warmRtf: 1 } }; },
  }));
  await runtime.transcribe(new Float32Array(16000), new Blob(["x"]));
  assert.equal(probeCalled, false);
});

// ─── ASR client（browser fallback） ────────────────────────────────

test("createLocalAsrClient：无 asrAPI → no-electron 降级", async () => {
  const client = createLocalAsrClient(undefined);
  const capability = await client.getCapability();
  assert.equal(capability.available, false);
  const r = await client.recognize(new Float32Array(1600));
  assert.equal(r.ok, false);
});
