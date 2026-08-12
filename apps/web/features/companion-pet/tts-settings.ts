/**
 * 桌宠 TTS 语音偏好（设置 → 伴星 → 伴星语音）。
 *
 * 设备级偏好，存 localStorage（同 origin 跨窗口共享：settings 页写入、
 * 桌宠窗口读取）。结构 v1：
 *   { voice: "zh-CN-XiaoxiaoNeural", rate: "+0%", segmentGapMs: 0 }
 *
 * - voice：edge-tts 音色 ShortName（空 = 服务端默认 zh-CN-XiaoxiaoNeural）；
 * - rate：语速（"-30%" | "+0%" | "+30%"），edge-tts rate 语法；
 * - segmentGapMs：段间额外停顿（0 = 无缝；播放器在每段播放结束后等待）。
 */

export interface PetTtsSettingsV1 {
  voice: string;
  rate: string;
  segmentGapMs: number;
}

const STORAGE_KEY = "ailearn.pet.tts.v1";

/** 常用中文音色（edge-tts ShortName → 展示名/风格）。 */
export const PET_TTS_VOICES: ReadonlyArray<{ value: string; label: string; hint: string }> = [
  { value: "zh-CN-XiaoxiaoNeural", label: "晓晓", hint: "女声 · 温暖亲切" },
  { value: "zh-CN-XiaoyiNeural", label: "晓伊", hint: "女声 · 活泼俏皮" },
  { value: "zh-CN-XiaohanNeural", label: "晓涵", hint: "女声 · 柔和沉静" },
  { value: "zh-CN-XiaomoNeural", label: "晓墨", hint: "女声 · 成熟大方" },
  { value: "zh-CN-YunxiNeural", label: "云希", hint: "男声 · 阳光少年" },
  { value: "zh-CN-YunjianNeural", label: "云健", hint: "男声 · 沉稳有力" },
  { value: "zh-CN-YunyangNeural", label: "云扬", hint: "男声 · 新闻播报" },
  { value: "zh-CN-YunxiaNeural", label: "云夏", hint: "童声 · 元气可爱" },
];

export const PET_TTS_RATES: ReadonlyArray<{ value: string; label: string; hint: string }> = [
  { value: "-30%", label: "舒缓", hint: "比标准慢 30%" },
  { value: "+0%", label: "标准", hint: "默认语速" },
  { value: "+30%", label: "轻快", hint: "比标准快 30%" },
];

export const PET_TTS_SEGMENT_GAPS: ReadonlyArray<{ value: number; label: string; hint: string }> = [
  { value: 0, label: "无缝", hint: "段与段紧接播放" },
  { value: 300, label: "短停顿", hint: "约 0.3 秒" },
  { value: 600, label: "中等停顿", hint: "约 0.6 秒" },
  { value: 1200, label: "长停顿", hint: "约 1.2 秒" },
];

export const DEFAULT_PET_TTS: PetTtsSettingsV1 = {
  voice: "zh-CN-XiaoxiaoNeural",
  rate: "+0%",
  segmentGapMs: 0,
};

export function readPetTtsSettings(): PetTtsSettingsV1 {
  if (typeof window === "undefined") return DEFAULT_PET_TTS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PET_TTS;
    const parsed = JSON.parse(raw) as Partial<PetTtsSettingsV1>;
    const voice =
      typeof parsed.voice === "string" && parsed.voice.length > 0
        ? parsed.voice
        : DEFAULT_PET_TTS.voice;
    const rate =
      typeof parsed.rate === "string" && parsed.rate.length > 0
        ? parsed.rate
        : DEFAULT_PET_TTS.rate;
    const segmentGapMs =
      typeof parsed.segmentGapMs === "number" &&
      Number.isFinite(parsed.segmentGapMs) &&
      parsed.segmentGapMs >= 0 &&
      parsed.segmentGapMs <= 5000
        ? Math.round(parsed.segmentGapMs)
        : DEFAULT_PET_TTS.segmentGapMs;
    return { voice, rate, segmentGapMs };
  } catch {
    return DEFAULT_PET_TTS;
  }
}

export function writePetTtsSettings(settings: PetTtsSettingsV1): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // 存储失败静默（如隐私模式）——偏好保持默认。
  }
}

/** 播放器创建时读取的配置子集（voice/rate/segmentGapMs）。 */
export function pickTtsSettingsForPlayback(): {
  voice: string;
  rate: string;
  segmentGapMs: number;
} {
  return readPetTtsSettings();
}
