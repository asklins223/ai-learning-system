/**
 * TTS 引擎选择与兜底（2026-09-19 语音链路改造）。
 *
 * 目标架构：**qwen（阿里百炼，WebSocket 原始协议 + 连接复用）为主，
 * edge-tts（容器 HTTP）兜底**。此前桌面伴星走的 `/voice/tts`（plain text）
 * 硬编码 edge——实测每段合成 2.3–2.5s，段间停顿与概率性中断都源于此；
 * qwen WS 引擎只挂在 ref 型 `/voice/tts/stream` 上，桌面根本够不着。
 *
 * 这里把"选引擎 + 失败降级"收敛成唯一入口：
 * - config `tts.engine === "qwen"` 且 workspaceId 已配置 → 走 qwen WS
 *   （按用户串行 + 全局有界并发 + 60s 连接复用，见 qwen-tts.ts）；
 * - qwen 任务失败（QwenTtsError / 网络错误）→ 记日志后自动降级 edge，
 *   不再让一次 WS 抖动直接变成一段听不到的语音；
 * - 语气标签（[excited] 等）是 qwen-audio 专属能力：qwen 原样传入，
 *   edge 合成前必须剥离（否则标签被当普通文字朗读出来）。
 */

import { stripVoiceExpressionTags } from "@ailearn/shared/voice-expression-tags";
import { edgeTtsSynthesize, type EdgeTtsProviderOptions } from "./edge-tts.ts";
import { loadTtsEngineConfig } from "./tts-config.ts";
import { qwenTtsSynthesizeStreamForUser, type QwenTtsOptions } from "./qwen-tts.ts";

export interface TtsBytesResult {
  audio: Uint8Array;
  /** 实际使用的引擎（降级后会是 "edge"）。 */
  engine: "qwen" | "edge";
  contentType: string;
}

export interface TtsEngineDeps {
  qwenSynthesize?: typeof qwenTtsSynthesizeStreamForUser;
  edgeSynthesize?: typeof edgeTtsSynthesize;
  loadConfig?: typeof loadTtsEngineConfig;
  /** 测试注入字节收集（缺省用 ReadableStream 全量读取）。 */
  collectStream?: (stream: ReadableStream<Uint8Array>) => Promise<Uint8Array>;
}

/** qwen 流 → 字节（句子级合成总量 30–60KB，缓冲无压力）。 */
async function defaultCollectStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export interface SynthesizeTtsBytesArgs {
  text: string;
  /** edge 音色（仅 edge 引擎使用）；qwen 音色固定走 config，不混用。 */
  edgeVoice: string;
  /** edge 语速（如 "+10%"）；qwen 语速走 config。 */
  edgeRate?: string;
  /** qwen 按用户串行的队列键（workspaceId:userId）。 */
  queueKey: string;
  /** qwen 降级 edge 时的观测钩子（日志/测试断言）。 */
  onQwenFallback?: (error: unknown) => void;
  deps?: TtsEngineDeps;
}

/**
 * 按配置选引擎合成一段语音，返回完整字节。
 *
 * qwen 分支的流在「task-started」即开始产出（首包延迟低）；任何 qwen 阶段
 * 失败都降级 edge 重合成——调用方拿到的一定是可播放的字节，或一个抛出的
 * EdgeTtsError（由路由层统一映射 502）。
 */
export async function synthesizeTtsBytes(args: SynthesizeTtsBytesArgs): Promise<TtsBytesResult> {
  const deps = args.deps ?? {};
  const qwenSynthesize = deps.qwenSynthesize ?? qwenTtsSynthesizeStreamForUser;
  const edgeSynthesize = deps.edgeSynthesize ?? edgeTtsSynthesize;
  const loadConfig = deps.loadConfig ?? loadTtsEngineConfig;
  const collectStream = deps.collectStream ?? defaultCollectStream;
  const cfg = loadConfig();

  const edgeOptions: EdgeTtsProviderOptions = {
    ...(args.edgeRate ? { rate: args.edgeRate } : {}),
  };

  if (cfg.engine === "qwen" && cfg.qwen.workspaceId) {
    const qwenOptions: QwenTtsOptions = {
      workspaceId: cfg.qwen.workspaceId,
      apiKey: process.env.DASHSCOPE_API_KEY ?? "",
      voice: cfg.qwen.voice,
      model: cfg.qwen.model,
      format: cfg.qwen.format,
      sampleRate: cfg.qwen.sampleRate,
      ...(cfg.qwen.instruction ? { instruction: cfg.qwen.instruction } : {}),
    };
    try {
      const result = await qwenSynthesize(args.queueKey, args.text, qwenOptions);
      const audio = await collectStream(result.stream);
      if (audio.length === 0) throw new Error("qwen tts returned empty audio");
      return { audio, engine: "qwen", contentType: result.contentType };
    } catch (error) {
      args.onQwenFallback?.(error);
      // 落到 edge 兜底。
    }
  }

  const edge = await edgeSynthesize(stripVoiceExpressionTags(args.text), args.edgeVoice, edgeOptions);
  return { audio: edge.audio, engine: "edge", contentType: edge.contentType };
}
