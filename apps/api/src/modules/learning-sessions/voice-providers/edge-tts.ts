/**
 * edge-tts TTS provider（真实实现，基于 Docker 容器 HTTP 调用）。
 *
 * 不依赖宿主 CLI：edge-tts 作为独立 Docker 容器运行（docker/edge-tts/），
 * 暴露 OpenAI 协议端点 POST /v1/audio/speech；本 provider 经
 * EDGE_TTS_BASE_URL（默认 http://edge-tts:8080）调用容器。
 *
 * 兼容性：与 openai-compatible-tts 共享相同请求形状（OpenAI 协议），
 * 因此 API 侧可无缝在 edge-tts 容器与自定义 OpenAI 协议 TTS 服务间切换。
 *
 * 真实请求验证（2026-08-08）：
 *   容器内 server.py 合成 zh-CN-XiaoxiaoNeural → audio/mpeg mp3 字节。
 */

export interface EdgeTtsProviderOptions {
  /** 容器地址（缺省 http://edge-tts:8080） */
  baseUrl?: string;
  /** 默认 voice（zh-CN） */
  voice?: string;
  /** 语速（edge-tts rate，如 +0% / -10%） */
  rate?: string;
  timeoutMs?: number;
  /** 测试注入 fetch */
  fetchImpl?: typeof fetch;
}

export interface EdgeTtsSynthesizeResult {
  /** mp3 音频字节 */
  audio: Uint8Array;
  /** 实际使用的 voice */
  voice: string;
  /** OpenAI 协议响应 content-type */
  contentType: string;
}

const DEFAULT_BASE_URL = "http://edge-tts:8080";
const DEFAULT_VOICE = "zh-CN-XiaoxiaoNeural";
const DEFAULT_TIMEOUT_MS = 30_000;

export class EdgeTtsError extends Error {
  readonly code: string;
  readonly status?: number;
  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = "EdgeTtsError";
    this.code = code;
    this.status = status;
  }
}

/**
 * 调 edge-tts 容器合成语音（OpenAI 协议 POST /v1/audio/speech）。
 * @param text 净化纯文本（不含 SSML/URL/脚本标记）
 * @param voice edge-tts voice id（如 zh-CN-XiaoxiaoNeural）
 * @param options 配置
 */
export async function edgeTtsSynthesize(
  text: string,
  voice: string,
  options: EdgeTtsProviderOptions = {},
): Promise<EdgeTtsSynthesizeResult> {
  if (typeof text !== "string" || text.trim() === "") {
    throw new EdgeTtsError("INVALID_ARGUMENT", "TTS 文本为空（fail closed）");
  }
  const baseUrl = options.baseUrl ?? process.env.EDGE_TTS_BASE_URL ?? DEFAULT_BASE_URL;
  const effectiveVoice = voice || (options.voice ?? DEFAULT_VOICE);
  const rate = options.rate ?? "+0%";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    // 容器鉴权（security_review MEDIUM）：共享 token 防内网任意调用
    const token = process.env.EDGE_TTS_AUTH_TOKEN;
    if (token) headers["X-Edge-TTS-Token"] = token;
    response = await fetchImpl(`${baseUrl}/v1/audio/speech`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "edge-tts",
        input: text,
        voice: effectiveVoice,
        rate,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    throw new EdgeTtsError(
      "NETWORK_ERROR",
      `edge-tts 容器不可达：${err instanceof Error ? err.message : String(err)}（检查 EDGE_TTS_BASE_URL 与 docker compose 中 edge-tts 服务）`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    await response.text().catch(() => ""); // 消费 body（内部细节不透出）
    throw new EdgeTtsError(
      "UPSTREAM_ERROR",
      `edge-tts HTTP ${response.status}（内部细节不向用户透出）`,
      response.status,
    );
  }
  const contentType = response.headers.get("content-type") ?? "audio/mpeg";
  const audio = new Uint8Array(await response.arrayBuffer());
  if (audio.length === 0) {
    throw new EdgeTtsError("EMPTY_AUDIO", "edge-tts 返回空音频（fail closed）");
  }
  return { audio, voice: effectiveVoice, contentType };
}
