// 音色目录是"能不能进上游"的唯一白名单，也是设置界面画出来的那份名单。
// 这两件事必须同源，所以这里守的是结构性事实：不重复、不跨引擎混用、
// 默认值就是列表第一条、试听句在服务端朗读上限之内。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_TTS_ENGINE,
  DEFAULT_TTS_VOICE,
  EDGE_TTS_VOICE_OPTIONS,
  QWEN_TTS_VOICE_OPTIONS,
  TTS_PREVIEW_ASSET_DIR,
  TTS_PREVIEW_TEXT,
  defaultTtsVoiceFor,
  findTtsVoiceOption,
  isTtsVoiceAllowed,
  ttsVoiceOptionsFor,
} from "./tts-voice-catalog.ts";

test("目录内 voice 不重复，且每条的 engine 与所在列表一致", () => {
  for (const [engine, options] of [
    ["qwen", QWEN_TTS_VOICE_OPTIONS],
    ["edge", EDGE_TTS_VOICE_OPTIONS],
  ] as const) {
    const voices = options.map((option) => option.voice);
    assert.equal(new Set(voices).size, voices.length, `${engine} 有重复音色`);
    assert.ok(voices.length > 0, `${engine} 列表为空`);
    for (const option of options) {
      assert.equal(option.engine, engine, `${option.voice} 挂错引擎`);
      assert.ok(option.name.trim().length > 0, `${option.voice} 没有界面名字`);
    }
  }
  const all = [...QWEN_TTS_VOICE_OPTIONS, ...EDGE_TTS_VOICE_OPTIONS].map((o) => o.voice);
  assert.equal(new Set(all).size, all.length, "两个引擎之间出现同名 voice");
});

test("qwen 音色带模型版本后缀：与 3.0 系音色不通用", () => {
  // 上游对不匹配的 voice 只回 `[cosyvoice:]Engine error [411]`，不会说是音色问题，
  // 所以这一条断言就是"升模型时别忘了连音色一起换"的兜底。
  for (const option of QWEN_TTS_VOICE_OPTIONS) {
    assert.match(option.voice, /_v\d+(?:\.\d+)?$/, `${option.voice} 缺版本后缀`);
  }
});

test("跨引擎不认：edge 的 voice 在 qwen 下非法，反之亦然", () => {
  assert.equal(isTtsVoiceAllowed("edge", "longhua_v3.1"), false);
  assert.equal(isTtsVoiceAllowed("qwen", "zh-CN-XiaoxiaoNeural"), false);
  assert.equal(isTtsVoiceAllowed("edge", "zh-CN-XiaoxiaoNeural"), true);
  assert.equal(isTtsVoiceAllowed("qwen", "not-a-real-voice"), false);
});

test("默认值取自列表第一条，不设第二个来源", () => {
  assert.equal(DEFAULT_TTS_ENGINE, "qwen");
  assert.equal(DEFAULT_TTS_VOICE, QWEN_TTS_VOICE_OPTIONS[0].voice);
  for (const engine of ["qwen", "edge"] as const) {
    assert.equal(defaultTtsVoiceFor(engine), ttsVoiceOptionsFor(engine)[0].voice);
    assert.ok(findTtsVoiceOption(engine, defaultTtsVoiceFor(engine)));
  }
  assert.equal(findTtsVoiceOption("qwen", "nope"), null);
});

test("每条音色都带本地录音路径，且落在同一个资产目录里", () => {
  // 试听不再现合成：路径缺一条，界面上就是一条点了没声的行。
  for (const option of [...QWEN_TTS_VOICE_OPTIONS, ...EDGE_TTS_VOICE_OPTIONS]) {
    assert.ok(option.previewAsset.startsWith(`${TTS_PREVIEW_ASSET_DIR}/`), option.voice);
    assert.ok(option.previewAsset.endsWith(".mp3"), option.voice);
    assert.equal(option.previewAsset, `${TTS_PREVIEW_ASSET_DIR}/${option.voice}.mp3`, option.voice);
  }
  const assets = [...QWEN_TTS_VOICE_OPTIONS, ...EDGE_TTS_VOICE_OPTIONS].map((o) => o.previewAsset);
  assert.equal(new Set(assets).size, assets.length, "两条音色共用一段录音");
});

test("试听句非空、单句、在朗读长度上限内", () => {
  assert.ok(TTS_PREVIEW_TEXT.trim().length > 0);
  assert.ok(TTS_PREVIEW_TEXT.length <= 120, "试听句要短到一点就能听完");
  assert.equal(TTS_PREVIEW_TEXT.includes("<"), false, "试听句不能含标签形状字符");
  assert.equal(/https?:\/\//.test(TTS_PREVIEW_TEXT), false);
});
