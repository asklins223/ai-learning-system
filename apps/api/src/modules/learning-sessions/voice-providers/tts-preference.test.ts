/**
 * 「她这次用哪一身」的判定测试（不碰库：偏好是传进来的原样值）。
 *
 * 守的是回落方向：宁可回 config 默认并标成"这不是你选的"，也不能让半个偏好生效
 * （引擎是用户的、音色是配置的），更不能拿一个目录外的 voice 去打上游。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveTtsSelection } from "./tts-preference.ts";
import type { TtsEngineConfig } from "./tts-config.ts";

const CFG: TtsEngineConfig = {
  engine: "qwen",
  qwen: {
    workspaceId: "llm-test",
    model: "qwen-audio-3.1-tts-flash",
    voice: "longhua_v3.1",
    format: "mp3",
    sampleRate: 22050,
    instruction: "",
  },
  edge: { voice: "zh-CN-XiaoxiaoNeural", rate: "+0%" },
};

test("没有偏好：整身回 config，并标成未显式设置", () => {
  assert.deepEqual(resolveTtsSelection(null, CFG), {
    engine: "qwen",
    qwenVoice: "longhua_v3.1",
    edgeVoice: "zh-CN-XiaoxiaoNeural",
    explicit: false,
  });
  assert.deepEqual(resolveTtsSelection({}, CFG).explicit, false);
});

test("成对的合法偏好：引擎与音色都按用户说的来", () => {
  const qwen = resolveTtsSelection({ engine: "qwen", voice: "longanlingxi_v3.1" }, CFG);
  assert.equal(qwen.engine, "qwen");
  assert.equal(qwen.qwenVoice, "longanlingxi_v3.1");
  assert.equal(qwen.explicit, true);

  const edge = resolveTtsSelection({ engine: "edge", voice: "zh-CN-XiaoxiaoNeural" }, CFG);
  assert.equal(edge.engine, "edge");
  assert.equal(edge.edgeVoice, "zh-CN-XiaoxiaoNeural");
  assert.equal(edge.explicit, true);
});

test("跨引擎的音色不认：宁可回默认，也不把 edge 的 voice 送给 qwen", () => {
  // 上游对不匹配的组合只回 `[cosyvoice:]Engine error [411]`，不会指出是音色问题，
  // 所以这一关必须在出网之前拦住。
  assert.equal(resolveTtsSelection({ engine: "qwen", voice: "zh-CN-XiaoxiaoNeural" }, CFG).explicit, false);
  assert.equal(resolveTtsSelection({ engine: "edge", voice: "longhua_v3.1" }, CFG).explicit, false);
  assert.equal(resolveTtsSelection({ engine: "qwen", voice: "made-up-voice" }, CFG).qwenVoice, "longhua_v3.1");
});

test("只存了半个偏好：整体回默认，不出现引擎与音色各表一头", () => {
  const onlyEngine = resolveTtsSelection({ engine: "edge" }, CFG);
  assert.equal(onlyEngine.explicit, false);
  assert.equal(onlyEngine.engine, "qwen", "config 的引擎");
  const onlyVoice = resolveTtsSelection({ voice: "longanhuan_v3.1" }, CFG);
  assert.equal(onlyVoice.explicit, false);
  assert.equal(onlyVoice.qwenVoice, "longhua_v3.1");
});

test("非字符串/未知引擎的存量值一律不生效", () => {
  for (const stored of [
    { engine: 1, voice: "longhua_v3.1" },
    { engine: "sambert", voice: "longhua_v3.1" },
    { engine: "qwen", voice: 42 },
    { engine: "qwen", voice: "" },
    { engine: null, voice: null },
  ]) {
    assert.equal(resolveTtsSelection(stored, CFG).explicit, false, JSON.stringify(stored));
  }
});

test("config 自己选 edge 时，未设置的账号就走 edge", () => {
  const resolved = resolveTtsSelection(null, { ...CFG, engine: "edge" });
  assert.equal(resolved.engine, "edge");
  assert.equal(resolved.explicit, false);
});
