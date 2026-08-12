#!/usr/bin/env node
/**
 * P6 §13：SenseVoice 真实性能基准（RTF / 冷启动 / 峰值内存增量）。
 *
 * 用法：
 *   node apps/web/scripts/sensevoice-bench.mjs [model-dir] [wav]
 *   - model-dir：含 model.int8.onnx + tokens.txt 的目录（默认 ./sensevoice-model）
 *   - wav：16kHz 单声道或任意 wav（自动转 16k mono），默认用模型自带 test_wavs/zh.wav
 *
 * 环境要求：
 *   - Node 20+（sherpa-onnx@1.13.4 的 wasm-nodejs 入口可直接执行；本脚本
 *     使用该版本的同步工厂与 acceptWaveform(sampleRate, samples) API）；
 *   - 模型下载：sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09.tar.bz2
 *     （~158MB，GitHub k2-fsa/sherpa-onnx releases asr-models）。
 *
 * 输出：JSON（audioSeconds / coldStartMs / peakMemoryDeltaMB / rtf[3] / text）。
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const cwd = process.cwd();

function usage() {
  console.error(
    "用法: node sensevoice-bench.mjs [model-dir] [wav]\n" +
      "  model-dir 默认 ./sensevoice-model；wav 默认 model-dir/test_wavs/zh.wav",
  );
  process.exit(2);
}

const modelDir = path.resolve(process.argv[2] ?? path.join(cwd, "sensevoice-model"));
const modelPath = path.join(modelDir, "model.int8.onnx");
const tokensPath = path.join(modelDir, "tokens.txt");
if (!existsSync(modelPath) || !existsSync(tokensPath)) {
  console.error(`模型缺失: ${modelPath} 或 ${tokensPath}（先下载解压 sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09）`);
  usage();
}

const wav = process.argv[3] ?? path.join(modelDir, "test_wavs", "zh.wav");
if (!existsSync(wav)) {
  console.error(`测试音频缺失: ${wav}`);
  usage();
}

let pcmBuf;
try {
  pcmBuf = execFileSync("/opt/homebrew/bin/ffmpeg", ["-i", wav, "-ar", "16000", "-ac", "1", "-f", "f32le", "-"], {
    stdio: ["ignore", "pipe", "ignore"],
  });
} catch {
  // ffmpeg 不在 /opt/homebrew 时尝试 PATH
  pcmBuf = execFileSync("ffmpeg", ["-i", wav, "-ar", "16000", "-ac", "1", "-f", "f32le", "-"], {
    stdio: ["ignore", "pipe", "ignore"],
  });
}
const pcm = new Float32Array(pcmBuf.buffer, pcmBuf.byteOffset, pcmBuf.byteLength / 4);
const seconds = pcm.length / 16000;
if (seconds < 1) {
  console.error(`测试音频过短: ${seconds.toFixed(2)}s（需 ≥1s）`);
  process.exit(2);
}

const mem0 = process.memoryUsage().rss;
const t0 = performance.now();
let sherpa;
try {
  sherpa = require("sherpa-onnx");
} catch {
  console.error("sherpa-onnx 未安装（cd apps/web && npm i sherpa-onnx）");
  process.exit(1);
}
try {
  const recognizer = sherpa.createOfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      tokens: tokensPath,
      provider: "cpu",
      debug: 0,
      senseVoice: {
        model: modelPath,
        language: "zh",
        useInverseTextNormalization: true,
      },
    },
  });
  const coldStartMs = performance.now() - t0;
  const times = [];
  let text = "";
  let peakRss = mem0;
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
  for (let i = 0; i < 3; i++) {
    const stream = recognizer.createStream();
    stream.acceptWaveform(16000, pcm);
    const t1 = performance.now();
    recognizer.decode(stream);
    times.push(performance.now() - t1);
    text = recognizer.getResult(stream).text;
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    stream.free?.();
  }
  const rtf = times.map((t) => +(t / (seconds * 1000)).toFixed(2));
  const coldStartOk = coldStartMs <= 3000;
  const rtfOk = Math.max(...rtf) <= 0.5;
  const memOk = (peakRss - mem0) / 1048576 <= 700;
  const out = {
    model: modelPath,
    wav,
    audioSeconds: +seconds.toFixed(2),
    coldStartMs: +coldStartMs.toFixed(0),
    peakMemoryDeltaMB: +((peakRss - mem0) / 1048576).toFixed(0),
    rtf,
    warmRtfMax: Math.max(...rtf),
    text,
    gate: {
      pass: coldStartOk && rtfOk && memOk,
      coldStartOk,
      rtfOk,
      memOk,
    },
  };
  recognizer.free?.();
  console.log("BENCH_RESULT " + JSON.stringify(out, null, 2));
  // Keep the JSON useful for diagnostics while making the contract Gate
  // enforceable in CI/shell pipelines.
  if (!out.gate.pass) process.exitCode = 3;
} catch (err) {
  console.error(
    "BENCH_FAILED:",
    err && (err.stack || err.message || String(err)).split("\n").slice(0, 3).join(" | "),
  );
  process.exit(1);
}
