/**
 * 15b：TTS 引擎配置读取（config/ai-platforms.json 的 tts 节点）。
 *
 * 结构：
 *   "tts": {
 *     "engine": "qwen" | "edge",          // 默认 qwen
 *     "qwen": { model, voice, format, sampleRate, workspaceId },
 *     "edge": { voice, rate }
 *   }
 *
 * 读取路径：dev 容器 cwd=/app 且 config mount 到 /app/config；宿主 cwd 为
 * apps/api 时用 ../.. 回退。workspaceId 支持 env 兜底 DASHSCOPE_TTS_WORKSPACE_ID。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface QwenTtsConfig {
  workspaceId: string;
  model: string;
  voice: string;
  format: string;
  sampleRate: number;
  /** 指令控制（高质量声音描述，≤100 字符；qwen-audio-3.0-tts-flash 系统音色支持任意指令） */
  instruction: string;
}

export interface TtsEngineConfig {
  engine: "qwen" | "edge";
  qwen: QwenTtsConfig;
  edge: { voice: string; rate: string };
}

const DEFAULTS: TtsEngineConfig = {
  engine: "qwen",
  qwen: {
    workspaceId: "",
    model: "qwen-audio-3.0-tts-flash",
    voice: "longanlingxi",
    format: "mp3",
    sampleRate: 22050,
    instruction: "可爱的年轻女性声音，25 岁左右，声音甜美温柔、略带活泼，语速自然适中，适合轻松陪伴式对话",
  },
  edge: { voice: "zh-CN-XiaoxiaoNeural", rate: "+0%" },
};

const CANDIDATE_PATHS = [
  resolve(process.cwd(), "config/ai-platforms.json"),
  "/app/config/ai-platforms.json",
  resolve(process.cwd(), "../../config/ai-platforms.json"),
];

let cached: TtsEngineConfig | null = null;

export function loadTtsEngineConfig(): TtsEngineConfig {
  if (cached) return cached;
  let parsed: { tts?: unknown } | null = null;
  for (const path of CANDIDATE_PATHS) {
    try {
      parsed = JSON.parse(readFileSync(path, "utf8")) as { tts?: unknown };
      if (parsed?.tts) break;
    } catch {
      // 路径不存在/解析失败 → 下一个
    }
  }
  const tts = (parsed?.tts ?? {}) as {
    engine?: string;
    qwen?: Partial<QwenTtsConfig>;
    edge?: { voice?: string; rate?: string };
  };
  cached = {
    engine: tts.engine === "edge" ? "edge" : DEFAULTS.engine,
    qwen: {
      workspaceId: tts.qwen?.workspaceId ?? process.env.DASHSCOPE_TTS_WORKSPACE_ID ?? DEFAULTS.qwen.workspaceId,
      model: tts.qwen?.model ?? DEFAULTS.qwen.model,
      voice: tts.qwen?.voice ?? DEFAULTS.qwen.voice,
      format: tts.qwen?.format ?? DEFAULTS.qwen.format,
      sampleRate: tts.qwen?.sampleRate ?? DEFAULTS.qwen.sampleRate,
      instruction: tts.qwen?.instruction ?? DEFAULTS.qwen.instruction,
    },
    edge: {
      voice: tts.edge?.voice ?? DEFAULTS.edge.voice,
      rate: tts.edge?.rate ?? DEFAULTS.edge.rate,
    },
  };
  return cached;
}

/** 测试用：清缓存（改配置后重新读取）。 */
export function resetTtsEngineConfigCache(): void {
  cached = null;
}
