/**
 * P6 §13：SenseVoice 集成层 + 探测执行器单元测试（mock factory/probe deps）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSenseVoiceConfig,
  SenseVoiceLocalRecognizer,
  type OfflineRecognizerLike,
  type SenseVoiceFactory,
} from "./companion-sherpa-sensevoice.ts";
import { runSenseVoiceProbe } from "./companion-asr-probe-runner.ts";

class FakeRecognizer implements OfflineRecognizerLike {
  results: string[] = [];
  sampleRate = 0;
  sampleLength = 0;
  streamFreed = false;
  recognizerFreed = false;
  constructor(results: string[] = []) { this.results = results; }
  createStream() {
    return {
      acceptWaveform: (sampleRate: number, samples: Float32Array) => {
        this.sampleRate = sampleRate;
        this.sampleLength = samples.length;
      },
      free: () => { this.streamFreed = true; },
    };
  }
  decode = () => {};
  getResult = () => ({ text: this.results.shift() ?? "你好" });
  free = () => { this.recognizerFreed = true; };
}

const factoryOf = (r: OfflineRecognizerLike): SenseVoiceFactory => ({
  createOfflineRecognizer: () => r,
});

test("buildSenseVoiceConfig：sense-voice 配置（model/tokens/language/INT）", () => {
  const cfg = buildSenseVoiceConfig({ modelPath: "/m/model.int8.onnx", tokensPath: "/m/tokens.txt", language: "zh" }) as {
    featConfig: { sampleRate: number };
    modelConfig: {
      tokens: string;
      provider: string;
      debug: number;
      senseVoice: { model: string; language: string; useInverseTextNormalization: boolean };
    };
  };
  assert.equal(cfg.featConfig.sampleRate, 16000);
  assert.equal(cfg.modelConfig.senseVoice.model, "/m/model.int8.onnx");
  assert.equal(cfg.modelConfig.tokens, "/m/tokens.txt");
  assert.equal(cfg.modelConfig.provider, "cpu");
  assert.equal(cfg.modelConfig.debug, 0);
  assert.equal(cfg.modelConfig.senseVoice.language, "zh");
  assert.equal(cfg.modelConfig.senseVoice.useInverseTextNormalization, true);
});

test("加载：load() 返回耗时并置 loaded；未加载识别抛错", async () => {
  const rec = new SenseVoiceLocalRecognizer(factoryOf(new FakeRecognizer()), {
    modelPath: "/m/m.onnx", tokensPath: "/m/t.txt",
  });
  assert.equal(rec.loaded, false);
  // 未加载识别 → 抛错（fail closed）
  assert.throws(() => rec.recognize({ pcm: new Float32Array(16000) }), /recognizer_not_loaded/);
  const ms = await rec.load();
  assert.ok(ms >= 0);
  assert.equal(rec.loaded, true);
});

test("未加载先 load 再识别 → 返回文本（去空白）", async () => {
  const fake = new FakeRecognizer(["  你好世界  "]);
  const rec = new SenseVoiceLocalRecognizer(factoryOf(fake), {
    modelPath: "/m/m.onnx", tokensPath: "/m/t.txt",
  });
  await rec.load();
  const result = rec.recognize({ pcm: new Float32Array(16000) });
  assert.equal(result.text, "你好世界");
  assert.ok(result.elapsedMs >= 0);
  assert.equal(fake.sampleRate, 16000);
  assert.equal(fake.sampleLength, 16000);
  assert.equal(fake.streamFreed, true);
  rec.dispose();
  assert.equal(fake.recognizerFreed, true);
});

test("空 PCM → 抛错（fail closed）", async () => {
  const rec = new SenseVoiceLocalRecognizer(factoryOf(new FakeRecognizer()), {
    modelPath: "/m/m.onnx", tokensPath: "/m/t.txt",
  });
  await rec.load();
  assert.throws(() => rec.recognize({ pcm: new Float32Array(0) }), /empty_pcm/);
});

test("探测：warm RTF = 耗时/音频时长，冷启动计时", async () => {
  const testAudio = new Float32Array(16000 * 4); // 4s @16k
  const probe = await runSenseVoiceProbe({
    loadModel: async () => 900,
    recognize: () => ({ text: "ok", elapsedMs: 800 }), // RTF = 800/4000 = 0.2
    memoryBytes: () => 1_000_000_000,
    testAudio,
    warmRounds: 3,
  });
  assert.equal(probe.coldStartMs, 900);
  assert.equal(probe.warmRtf, 0.2);
  assert.equal(probe.modelCrashed, false);
  assert.equal(probe.modelLoadFailed, false);
  assert.equal(probe.sustainedSlow, false);
});

test("探测：RTF>0.8 连续窗口 → sustainedSlow（降级触发）", async () => {
  const probe = await runSenseVoiceProbe({
    loadModel: async () => 500,
    recognize: () => ({ text: "ok", elapsedMs: 4000 }), // RTF = 1.0（4s 音频）
    memoryBytes: () => 2_000_000_000,
    testAudio: new Float32Array(16000 * 4),
    warmRounds: 3,
  });
  assert.equal(probe.sustainedSlow, true, "连续窗口 RTF>0.8");
});

test("探测：模型加载失败 / 识别崩溃 → 对应标记", async () => {
  const fail = await runSenseVoiceProbe({
    loadModel: async () => { throw new Error("load fail"); },
    recognize: () => ({ text: "", elapsedMs: 0 }),
    memoryBytes: () => 0,
    testAudio: new Float32Array(16000),
  });
  assert.equal(fail.modelLoadFailed, true);
  const crash = await runSenseVoiceProbe({
    loadModel: async () => 100,
    recognize: () => { throw new Error("crash"); },
    memoryBytes: () => 0,
    testAudio: new Float32Array(16000),
  });
  assert.equal(crash.modelCrashed, true);
});

test("探测：峰值内存增量 = 结束-基线", async () => {
  let mem = 1_000_000_000;
  const probe = await runSenseVoiceProbe({
    loadModel: async () => 200,
    recognize: () => { mem += 150 * 1024 * 1024; return { text: "ok", elapsedMs: 100 }; },
    memoryBytes: () => mem,
    testAudio: new Float32Array(16000 * 3),
    warmRounds: 1,
  });
  assert.equal(probe.peakMemoryDeltaMB, 150);
});
