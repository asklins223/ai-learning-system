/**
 * TTS 音色目录（设置 → 语音与伴星 的唯一数据源）。
 *
 * 为什么放在 shared：这三处必须读同一份名单，任何一处自定都会漂移——
 *   1. 服务端校验用户偏好与试听请求（音色值直接进上游计费接口，不能由前端自由传）；
 *   2. 设置界面画可选项；
 *   3. 合成链路把偏好翻成 provider 参数。
 *
 * 音色的「声线特质 / 适用场景 / 试听语种」原文取自阿里百炼《Qwen-Audio-TTS 音色列表》，
 * 不自行形容音质：我们对音色的判断只有官方那一条，猜出来的描述会误导选择。
 * 名字里的 `_v3.1` 后缀是模型版本号，**不能**与 `qwen-audio-3.0-tts-flash` 混用
 * （混用时上游只回 `[cosyvoice:]Engine error [411]`，不说是音色不对）。
 */

import { z } from "zod";

/** 两条引擎取值；界面选项与服务端校验都从这一行派生。 */
export const TTS_ENGINE_VALUES = ["qwen", "edge"] as const;
export type TtsEngineV1 = (typeof TTS_ENGINE_VALUES)[number];

/** 引擎的 zod 取值：偏好合同、IPC 入参、试听请求共用这一个枚举实例（枚举写两遍会各说各话）。 */
export const ttsEngineV1Schema = z.enum(TTS_ENGINE_VALUES);

export interface TtsVoiceOptionV1 {
  /** 引擎；同一份列表里两类引擎的音色互不相干。 */
  engine: TtsEngineV1;
  /** 进上游 `voice` 参数的值，也是持久化到偏好里的值。 */
  voice: string;
  /** 界面上显示的名字。 */
  name: string;
  /** 一行补充说明（官方声线特质，或试听语种）；空串表示官方没给。 */
  note: string;
}

/** 千问可选音色。第一条是默认值，改这一条要同步改 config `tts.qwen.voice`。 */
export const QWEN_TTS_VOICE_OPTIONS: readonly TtsVoiceOptionV1[] = [
  {
    engine: "qwen",
    voice: "longhua_v3.1",
    name: "龙华",
    note: "元气甜美女 · 社交陪伴",
  },
  {
    engine: "qwen",
    voice: "longanlingxi_v3.1",
    name: "龙安灵希",
    note: "可爱甜美音 · 社交陪伴",
  },
  {
    engine: "qwen",
    voice: "longanlingxin_v3.1",
    name: "龙安灵心",
    note: "可说方言与外语，官方试听：陕西话、云南话、上海话、法语、意大利语",
  },
  {
    engine: "qwen",
    voice: "longanfengyue_v3.1",
    name: "龙安风悦",
    note: "可说方言与外语，官方试听：东北话、越南语、日语",
  },
  {
    engine: "qwen",
    voice: "longanhuan_v3.1",
    name: "龙安欢",
    note: "可说方言与外语，官方试听：重庆话、宁波话、韩语、印尼语",
  },
] as const;

/** edge-tts 固定一条：这条链路本来只是千问不可用时的退路，不打算给它做音色菜单。 */
export const EDGE_TTS_VOICE_OPTIONS: readonly TtsVoiceOptionV1[] = [
  {
    engine: "edge",
    voice: "zh-CN-XiaoxiaoNeural",
    name: "晓晓",
    note: "",
  },
] as const;

export const DEFAULT_TTS_ENGINE: TtsEngineV1 = QWEN_TTS_VOICE_OPTIONS[0].engine;
export const DEFAULT_TTS_VOICE = QWEN_TTS_VOICE_OPTIONS[0].voice;

/** 某引擎的默认音色 = 该引擎列表的第一条（顺序即优先级，不再另设常量）。 */
export function defaultTtsVoiceFor(engine: TtsEngineV1): string {
  return ttsVoiceOptionsFor(engine)[0].voice;
}

/** 试听句：固定写在这里，界面与服务端读同一句，才存在"听到的就是这段文字"这件事。 */
export const TTS_PREVIEW_TEXT = "你好呀，我是伴星。今天想一起学点什么？我在这儿陪你慢慢来。";

export function ttsVoiceOptionsFor(engine: TtsEngineV1): readonly TtsVoiceOptionV1[] {
  return engine === "qwen" ? QWEN_TTS_VOICE_OPTIONS : EDGE_TTS_VOICE_OPTIONS;
}

/**
 * 某引擎下可用的 voice 白名单。
 *
 * 只认这一份：试听与偏好写入都走它，越界的值一律拒。`voice` 会直接进上游的计费
 * 接口，放一个前端可任意填写的字符串过去，等于把这条链路开成付费代理。
 */
export function isTtsVoiceAllowed(engine: TtsEngineV1, voice: string): boolean {
  return ttsVoiceOptionsFor(engine).some((option) => option.voice === voice);
}

export function findTtsVoiceOption(engine: TtsEngineV1, voice: string): TtsVoiceOptionV1 | null {
  return ttsVoiceOptionsFor(engine).find((option) => option.voice === voice) ?? null;
}
