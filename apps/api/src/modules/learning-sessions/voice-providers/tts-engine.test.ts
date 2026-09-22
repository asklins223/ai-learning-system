/**
 * TTS 引擎选择器单测（2026-09-19 语音链路改造）：
 * - qwen 成功 → 直接返回 qwen 字节，不碰 edge；
 * - qwen 失败 → 自动降级 edge（语气标签在 edge 前剥离）；
 * - qwen 未配置 workspaceId → 直接 edge；
 * - engine=edge → qwen 完全不被调用。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { synthesizeTtsBytes, type TtsEngineDeps } from "./tts-engine.ts";
import type { TtsEngineConfig } from "./tts-config.ts";

function makeConfig(engine: "qwen" | "edge", workspaceId: string): TtsEngineConfig {
  return {
    engine,
    qwen: {
      workspaceId,
      model: "qwen-audio-3.1-tts-flash",
      voice: "longanlingxi_v3.1",
      format: "mp3",
      sampleRate: 22050,
      instruction: "",
    },
    edge: { voice: "zh-CN-XiaoxiaoNeural", rate: "+0%" },
  };
}

const bytes = (text: string): Uint8Array => new TextEncoder().encode(`audio:${text}`);
const streamOf = (text: string): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes(text));
      controller.close();
    },
  });

const baseDeps = (overrides: Partial<TtsEngineDeps>): TtsEngineDeps => ({
  collectStream: async (stream) => {
    const chunks: Uint8Array[] = [];
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    let total = 0;
    for (const c of chunks) total += c.length;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      out.set(c, offset);
      offset += c.length;
    }
    return out;
  },
  ...overrides,
});

test("qwen 成功：返回 qwen 字节，不调用 edge", async () => {
  let edgeCalls = 0;
  const result = await synthesizeTtsBytes({
    text: "[excited]哇，背完三十个！",
    edgeVoice: "zh-CN-XiaoxiaoNeural",
    queueKey: "ws:user",
    deps: baseDeps({
      loadConfig: () => makeConfig("qwen", "ws-123"),
      qwenSynthesize: async (_key, text) => ({ stream: streamOf(`qwen:${text}`), contentType: "audio/mpeg" }),
      edgeSynthesize: async () => {
        edgeCalls += 1;
        throw new Error("edge must not be called");
      },
    }),
  });
  assert.equal(result.engine, "qwen");
  assert.equal(new TextDecoder().decode(result.audio), "audio:qwen:[excited]哇，背完三十个！");
  assert.equal(edgeCalls, 0);
});

test("qwen 失败：降级 edge，且 edge 拿到的是剥离语气标签后的文本", async () => {
  const fallbacks: unknown[] = [];
  let edgeText = "";
  const result = await synthesizeTtsBytes({
    text: "[excited]哇，背完三十个！",
    edgeVoice: "zh-CN-XiaoxiaoNeural",
    queueKey: "ws:user",
    onQwenFallback: (error) => fallbacks.push(error),
    deps: baseDeps({
      loadConfig: () => makeConfig("qwen", "ws-123"),
      qwenSynthesize: async () => { throw new Error("ws boom"); },
      edgeSynthesize: async (text) => {
        edgeText = text;
        return { audio: bytes("edge"), voice: text, contentType: "audio/mpeg" };
      },
    }),
  });
  assert.equal(result.engine, "edge");
  assert.equal(edgeText, "哇，背完三十个！");
  assert.equal(fallbacks.length, 1);
});

test("qwen 未配置 workspaceId：直接 edge，不调用 qwen", async () => {
  let qwenCalls = 0;
  const result = await synthesizeTtsBytes({
    text: "你好",
    edgeVoice: "zh-CN-XiaoxiaoNeural",
    queueKey: "ws:user",
    deps: baseDeps({
      loadConfig: () => makeConfig("qwen", ""),
      qwenSynthesize: async () => {
        qwenCalls += 1;
        throw new Error("qwen must not be called");
      },
      edgeSynthesize: async (text) => ({ audio: bytes(text), voice: text, contentType: "audio/mpeg" }),
    }),
  });
  assert.equal(result.engine, "edge");
  assert.equal(qwenCalls, 0);
});

test("engine=edge：qwen 完全不参与", async () => {
  let qwenCalls = 0;
  const result = await synthesizeTtsBytes({
    text: "你好",
    edgeVoice: "zh-CN-XiaoxiaoNeural",
    queueKey: "ws:user",
    deps: baseDeps({
      loadConfig: () => makeConfig("edge", "ws-123"),
      qwenSynthesize: async () => {
        qwenCalls += 1;
        throw new Error("qwen must not be called");
      },
      edgeSynthesize: async (text) => ({ audio: bytes(text), voice: text, contentType: "audio/mpeg" }),
    }),
  });
  assert.equal(result.engine, "edge");
  assert.equal(qwenCalls, 0);
});

// ─── 用户音色偏好（selection 覆盖 config）───────────────────────────────

test("selection 指定 qwen 音色：进上游的是这一身，不是 config 那条", async () => {
  let seenVoice = "";
  const result = await synthesizeTtsBytes({
    text: "你好",
    edgeVoice: "zh-CN-XiaoxiaoNeural",
    queueKey: "ws:user",
    selection: { engine: "qwen", qwenVoice: "longanlingxi_v3.1", edgeVoice: "zh-CN-XiaoxiaoNeural", explicit: true },
    deps: baseDeps({
      loadConfig: () => makeConfig("qwen", "ws-123"),
      qwenSynthesize: async (_key, _text, options) => {
        seenVoice = options.voice;
        return { stream: streamOf("qwen"), contentType: "audio/mpeg" };
      },
      edgeSynthesize: async () => {
        throw new Error("edge must not be called");
      },
    }),
  });
  assert.equal(result.engine, "qwen");
  assert.equal(seenVoice, "longanlingxi_v3.1");
});

test("selection 说 edge：config 是 qwen 也不碰 qwen，不做'先试千问再降级'", async () => {
  // 用户明确挑了 edge，让 qwen 先试一遍等于把设置里那个选择演成没发生过
  // （而且 qwen 成功时根本不会降级，播出去的还是千问的声音）。
  let qwenCalls = 0;
  const result = await synthesizeTtsBytes({
    text: "你好",
    edgeVoice: "zh-CN-XiaoxiaoNeural",
    queueKey: "ws:user",
    selection: { engine: "edge", qwenVoice: "longhua_v3.1", edgeVoice: "zh-CN-XiaoxiaoNeural", explicit: true },
    deps: baseDeps({
      loadConfig: () => makeConfig("qwen", "ws-123"),
      qwenSynthesize: async () => {
        qwenCalls += 1;
        return { stream: streamOf("qwen"), contentType: "audio/mpeg" };
      },
      edgeSynthesize: async () => ({ audio: bytes("edge"), contentType: "audio/mpeg" }),
    }),
  });
  assert.equal(result.engine, "edge");
  assert.equal(qwenCalls, 0);
});

test("不传 selection：仍旧用 config 那条音色（默认行为没被动过）", async () => {
  let seenVoice = "";
  await synthesizeTtsBytes({
    text: "你好",
    edgeVoice: "zh-CN-XiaoxiaoNeural",
    queueKey: "ws:user",
    deps: baseDeps({
      loadConfig: () => makeConfig("qwen", "ws-123"),
      qwenSynthesize: async (_key, _text, options) => {
        seenVoice = options.voice;
        return { stream: streamOf("qwen"), contentType: "audio/mpeg" };
      },
      edgeSynthesize: async () => {
        throw new Error("edge must not be called");
      },
    }),
  });
  assert.equal(seenVoice, makeConfig("qwen", "ws-123").qwen.voice);
});
