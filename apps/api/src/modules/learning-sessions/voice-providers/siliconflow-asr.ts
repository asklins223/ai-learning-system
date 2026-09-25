/**
 * SiliconFlow ASR provider（真实实现）。
 *
 * 接入硅基流动（SiliconFlow）平台的 TeleSpeechASR 模型：
 *   POST https://api.siliconflow.cn/v1/audio/transcriptions
 *   Authorization: Bearer <SILICONFLOW_API_KEY>
 *   multipart/form-data: file=<audio> + model=FunAudioLLM/SenseVoiceSmall
 *   响应: { "text": "string" }
 *
 * 实现当前 companion voice 路由使用的 ASR provider：
 * - 逐字 transcript（SenseVoice 返回识别文本，按 utterance 分段）；
 * - 低置信标记：SiliconFlow 响应无逐词置信度，保守起见关键术语不做
 *   自动降级，交由 assessTranscriptionQuality 的规则层判定；
 * - provider/model/version 元数据落 artifact（§13.2 数据治理）。
 *
 * 真实请求验证（2026-08-08）：
 *   edge-tts 合成 mp3 → 本 provider → HTTP 200 { "text": "测试语音。" }
 *
 * 运行基础（2026-09-25，39d W3-5）：这一次调用跑在
 * `@ailearn/shared/ai-task-kernel` 上——预算、重试、取消与"不许在事务里调外部模型"
 * 由那一层统一管，本文件只留 provider 合同（multipart 组装、错误码语汇、fail closed）。
 * 改之前这里是**一次失败就直接 502**：用户举着刚录好的音频，什么都没拿到。
 *
 * 真跑读数（2026-09-25）：**这台机器到不了 SiliconFlow**——`api.siliconflow.cn` 解析到合成
 * DNS 段（198.18.0.x），POST 挂到 30s 被内核判成 `timeout`、重试一次后 fail closed。
 * 所以真实端到端识别仍欠一次验证；下面的替身用例证的是分类与预算，不是识别质量。
 */

export interface SiliconFlowAsrOptions {
  /** SILICONFLOW_API_KEY（.env）；缺省抛错（fail closed） */
  apiKey?: string;
  /** 默认模型（可由 workspace policy 覆盖） */
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  /**
   * 发请求那一步。留这个口子只为把「重试几次、哪些算瞬时、哪些算形状问题」测出来——
   * 那些判据以前只存在于一段没有一条用例跑过的代码里。
   * （默认实现见 `postMultipart`，那里记着「为什么这条出口没有公网地址闸」的实测理由。）
   */
  requester?: AsrRequester;
  /**
   * 这一次转写属于谁（**必填、无默认**）。语音是最贵的一种输入：用户举着麦克风
   * 等，一次没成就要重来。所以"重试几次、算不算瞬时故障"必须有地方钉住，
   * 而钉住它需要知道是谁的哪一段音频（进幂等键与检查点身份）。
   * 可选就等于"忘记核对"是一种可以通过的形状。
   */
  scope: AsrCallScope;
  /**
   * 「当前作用域有没有活动事务」那一个读数（必填，同 `scope` 的理由）。
   * 语音上传这条路径今天整段都在事务外；这一读数把它**钉成**事务外，
   * 以后谁把转写挪进 `withWorkspaceTransaction` 会当场被拒。
   */
  currentActiveTransaction: () => unknown;
}

/** 调用环境：谁的这段音频。音频指纹由本文件自己算，调用方传不进一个错的。 */
export interface AsrCallScope {
  workspaceId: string;
  userId: string;
}

/** 一次 multipart POST。默认实现带公网地址闸（见 `postMultipartToPublicEndpoint`）。 */
export type AsrRequester = (
  url: string,
  init: { headers: Record<string, string>; body: Uint8Array<ArrayBuffer>; signal: AbortSignal },
) => Promise<Response>;

export interface SiliconFlowAsrResult {
  text: string;
  /** provider 返回的原始响应（用于日志/审计；不含敏感内容） */
  rawText: string;
}

const DEFAULT_BASE_URL = "https://api.siliconflow.cn/v1/audio/transcriptions";
const DEFAULT_MODEL = "FunAudioLLM/SenseVoiceSmall";
/** 单次尝试的硬上限（改外壳前后都是 30s，这一步没变过）。 */
const DEFAULT_TIMEOUT_MS = 30_000;
/**
 * 整任务预算。语音是"用户举着麦克风等"的那一档，所以总时长要有硬上限：
 * 30s 的第一步失败后只剩 25s 给第二次尝试，第二次再慢就整体超时而不是无限等。
 * 这一条以前不存在（那时根本没有第二次尝试），现在由 `taskDeadlineMs` 一处写住。
 */
const ASR_TASK_DEADLINE_MS = 55_000;
const ASR_PROMPT_VERSION = "siliconflow-asr-v1";

import { createHash, randomUUID } from "node:crypto";
import { runAiTask, type AiTaskDefinition } from "@ailearn/shared/ai-task-kernel";
import { DomainError } from "@ailearn/shared";

/** SiliconFlow API 错误（服务端错误消息不透出到 UI，仅内部记录） */
export class SiliconFlowAsrError extends DomainError {
  readonly status?: number;
  constructor(code: string, message: string, status?: number) {
    super({ name: "SiliconFlowAsrError", code, message, statusCode: status });
    this.status = status;
  }
}

/** 净化上传文件名：剔除控制字符/引号/换行（防 multipart 注入，security_review MEDIUM） */
function sanitizeUploadFilename(raw: string): string {
  const cleaned = raw.replace(/[\r\n"\u0000-\u001f]/g, "").trim();
  if (cleaned === "") return "audio-upload.mp3";
  if (cleaned.length > 120) return `audio-${cleaned.slice(-80)}`;
  return cleaned;
}

function isTransientAsrStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/** 这段音频的指纹（身份只由字节决定，见 `asrIdempotencyKey`）。 */
export function asrAudioSha256(audio: Uint8Array): string {
  return createHash("sha256").update(audio).digest("hex");
}

/**
 * 转写这一步的幂等键。**只由音频字节决定**：重试要认得出"还是那段录音"，
 * 掺进随机串或时间戳就等于每一次都像新请求——那样这条键只剩占位的作用。
 */
export function asrIdempotencyKey(audioSha256: string): string {
  return `voice-transcribe:${audioSha256}`;
}

/**
 * 默认出口。**这里刻意没有接公网地址闸**（`assertPublicHttpsAIEndpoint`）——
 * 不是漏了，是量过之后撤的：2026-09-25 那一次真跑发现本机的
 * `api.siliconflow.cn` 解析进 `198.18.0.38`（Docker Desktop／代理的合成 DNS 段），
 * 那道闸直接判定 "all resolved addresses are private" 并拒掉整个请求；
 * 而它原本要防的场景今天并不存在（baseUrl 只能由代码给，不是用户输入）。
 * ⇒ 给一条**活着的用户输入路径**（语音）加一道今天挡不住任何真实威胁、
 * 却会立刻让代理网络下的识别全灭的闸，是拿现有可能性换一个未来可能性，不做。
 *
 * 重新接上的前提（谁要做请先满足再动手）：① 有办法在代理／合成 DNS 环境下放行
 * （`AI_ALLOW_DOCKER_DESKTOP_SYNTHETIC_DNS` 那把总控太宽，会把 JSON 那条一起放宽）；
 * ② 有一次真机 ASR 读数能证明"加了闸仍然识别得出来"。在那之前这条保持裸 fetch。
 */
const postMultipart: AsrRequester = async (url, init) => globalThis.fetch(url, {
  method: "POST",
  headers: init.headers,
  body: init.body,
  signal: init.signal,
});

/**
 * 组装 multipart 请求体（一次性，两次尝试共用同一份字节）。
 * 边界串在这里生成，所以它不属于"每次重试重新协商"的那一类东西——
 * 重试的是同一份请求，不是重新录一遍。
 */
/**
 * 已组装好的请求体。`bytes` 的泛型参数不是多余的：`Uint8Array<ArrayBufferLike>`
 * 喂不进 `fetch` 的 BodyInit（TS 只认后端是 `ArrayBuffer` 的那一种），
 * 而这份字节要穿过任务定义的 `prepare → execute`，所以形状得具名。
 */
interface AsrRequestBody {
  bytes: Uint8Array<ArrayBuffer>;
  boundary: string;
}

function buildAsrRequestBody(
  audioBuffer: Uint8Array,
  safeFilename: string,
  model: string,
): AsrRequestBody {
  const boundary = `----SiliconFlowAsrBoundary${Date.now().toString(36)}${Math.random()
    .toString(36)
    .slice(2, 10)}`;
  const encoder = new TextEncoder();
  const modelField = encoder.encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${model}\r\n`,
  );
  const fileHeader = encoder.encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeFilename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
  );
  const fileFooter = encoder.encode(`\r\n--${boundary}--\r\n`);

  const body = new Uint8Array(
    modelField.length + fileHeader.length + audioBuffer.length + fileFooter.length,
  );
  body.set(modelField, 0);
  body.set(fileHeader, modelField.length);
  body.set(audioBuffer, modelField.length + fileHeader.length);
  body.set(fileFooter, modelField.length + fileHeader.length + audioBuffer.length);
  return { bytes: body, boundary };
}

/**
 * 调 SiliconFlow 语音识别。
 * @param audioBuffer 音频字节（mp3/wav/m4a；SenseVoice 支持常见格式）
 * @param filename 上传文件名（推断 MIME；内部净化防 multipart 注入）
 * @param options 配置 ＋ 这一次调用的归属（`scope` 与边界读数都必填）
 *
 * 转写这一步跑在公共任务运行基础上（39c §9 第二步 / 39d W3-5 的「语音转写」那一格）。
 * 换掉的是**执行纪律**，不是 provider 合同：multipart 组装、`sanitizeUploadFilename`
 * 的净化、四个错误码（MISSING_API_KEY / NETWORK_ERROR / UPSTREAM_ERROR /
 * EMPTY_TRANSCRIPT）与"内部细节不向用户透出"这条约定一字未改。
 * 以前这里**一次失败就直接 502**——用户举着刚录好的 30 秒音频，什么都没拿到。
 * 现在瞬时故障（408/425/429/5xx 与连接层报错）自动再来一次，其余不重试。
 */
export async function siliconFlowTranscribe(
  audioBuffer: Uint8Array,
  filename: string,
  options: SiliconFlowAsrOptions,
): Promise<SiliconFlowAsrResult> {
  const apiKey = options.apiKey ?? process.env.SILICONFLOW_API_KEY;
  if (!apiKey) {
    throw new SiliconFlowAsrError(
      "MISSING_API_KEY",
      "SILICONFLOW_API_KEY 未配置（fail closed：不静默跳过语音识别）",
    );
  }
  const url = options.baseUrl ?? DEFAULT_BASE_URL;
  const model = options.model ?? DEFAULT_MODEL;
  const stepTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const requester = options.requester ?? postMultipart;
  const safeFilename = sanitizeUploadFilename(filename);
  const requestBody = buildAsrRequestBody(audioBuffer, safeFilename, model);
  const audioSha256 = asrAudioSha256(audioBuffer);

  let lastUpstreamStatus: number | undefined;
  type Transcript = { text: string };

  const task: AiTaskDefinition<AsrRequestBody, Transcript> = {
    id: "voice_transcription",
    version: 1,
    mode: "structured",
    // 用户举着麦克风等，属于交互档名额（D5 §3 第 2 条）。
    resourceClass: "interactive_ai",
    budget: {
      maxModelCalls: 2,
      stepTimeoutMs,
      taskDeadlineMs: ASR_TASK_DEADLINE_MS,
      maxAutoRetries: 1,
    },
    completion: { kind: "structured_parsed" },
    usageContext: { modelId: model, promptVersion: ASR_PROMPT_VERSION, resourceClass: "interactive_ai" },
    prepare: async () => requestBody,
    execute: async (input, step) => {
      let response: Response;
      try {
        response = await requester(url, {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": `multipart/form-data; boundary=${input.boundary}`,
          },
          body: input.bytes,
          // 单步时长由内核的 signal 管（它已经是 `min(stepTimeoutMs, 剩余预算)`），
          // 这里不再自己 `setTimeout` 一个数字——同一个预算只准有一个来源。
          signal: step.signal,
        });
      } catch (err) {
        // 连接层失败（DNS/代理/对端断开）。本函数不接受外部取消信号，所以按下去的
        // 只可能是这一步自己的超时；两者都可重试，最终仍 fail closed。
        const message = err instanceof Error ? err.message : String(err);
        return step.signal.aborted
          ? { ok: false as const, class: "timeout" as const, message: `SiliconFlow ASR 超时：${message}` }
          : { ok: false as const, class: "transport" as const, message: `SiliconFlow ASR 网络错误：${message}` };
      }
      if (!response.ok) {
        await response.text().catch(() => ""); // 消费 body（内部细节不透出）
        lastUpstreamStatus = response.status;
        // 瞬时码值得再问一次；其余 4xx 是请求本身不对，重试只是让用户多等。
        return isTransientAsrStatus(response.status)
          ? { ok: false as const, class: "transport" as const, message: `SiliconFlow ASR HTTP ${response.status}` }
          : { ok: false as const, class: "invalid_input" as const, message: `SiliconFlow ASR HTTP ${response.status}` };
      }
      // 200 但内容不可用：形状问题（内核给一次修复机会，仍不合就 fail closed）。
      let parsed: { text?: unknown };
      try {
        parsed = (await response.json()) as { text?: unknown };
      } catch (err) {
        // 以前这里抛的是裸 SyntaxError ⇒ 路由不认，用户收到 500。归成形状问题后
        // 与空 transcript 同一出口：502 ＋ 静态文案。
        return { ok: false as const, class: "output_shape" as const, message: `响应不是合法 JSON：${String(err)}` };
      }
      const text = typeof parsed.text === "string" ? parsed.text.trim() : "";
      if (text === "") {
        return { ok: false as const, class: "output_shape" as const, message: "SiliconFlow ASR 返回空 transcript" };
      }
      return { ok: true as const, output: { text } };
    },
    // 恒等提交：pending voice artifact 的写入在 companion-voice-service 的第二段
    // 短事务里（那一步要 sha256 与 duration 都已实测），不借这个外壳搬家。
    commit: async (_ctx, _attempt, output) => ({
      outcome: "committed" as const,
      output,
      usage: { modelCalls: 0, promptTokens: 0, completionTokens: 0, elapsedMs: 0, autoRetriesUsed: 0 },
      failure: null,
      preservedValidResult: false,
      resumedFromCheckpoint: false,
      modelCalls: 0,
    }),
  };

  const receipt = await runAiTask(task, {
    ctx: {
      workspaceId: options.scope.workspaceId,
      userId: options.scope.userId,
      inputSnapshotRef: { kind: "audio", id: audioSha256, hash: audioSha256 },
      permissionLevel: "server",
    },
    attempt: {
      taskId: task.id,
      taskVersion: task.version,
      attemptId: randomUUID(),
      // 这段音频还没有 artifact 行（artifact 在转写成功之后才写），所以身份只能
      // 落在字节哈希上——这正是"同一段录音的两次尝试"该有的同一件事。
      leaseToken: `voice-transcribe:${audioSha256.slice(0, 16)}`,
      idempotencyKey: asrIdempotencyKey(audioSha256),
      workspaceId: options.scope.workspaceId,
      userId: options.scope.userId,
    },
    currentActiveTransaction: options.currentActiveTransaction,
    reportDevelopmentError: (message) => process.stderr.write(`[dev-error] ${message}\n`),
  });

  // 「没有可用输出」与「内核没提交成功」是同一个出口的两个说法，所以一起判：
  // 判完之后剩下的那一条 `transcript` 才是可以返回给用户的东西。
  const transcript = receipt.output;
  if (!transcript || (receipt.outcome !== "committed" && receipt.outcome !== "resumed_and_committed")) {
    const failure = receipt.failure;
    // 错误码沿用改外壳之前的那三个：路由只按 `code` 归一化文案（review 2026-08-12），
    // 换外壳不许改掉客户端能认的语汇。
    if (failure?.class === "output_shape") {
      // 空 transcript 与"200 但内容不合合同"走同一个出口：客户端只认 `code`
      // （语音那条链的错误语汇是固定的），但内部记录要说得出是哪一种。
      throw new SiliconFlowAsrError(
        "EMPTY_TRANSCRIPT",
        `SiliconFlow ASR 没有给出可用转写（fail closed）：${failure.message}`,
      );
    }
    if (lastUpstreamStatus !== undefined) {
      throw new SiliconFlowAsrError(
        "UPSTREAM_ERROR",
        `SiliconFlow ASR HTTP ${lastUpstreamStatus}（内部细节不向用户透出）`,
        lastUpstreamStatus,
      );
    }
    throw new SiliconFlowAsrError(
      "NETWORK_ERROR",
      `SiliconFlow ASR 网络错误：${failure?.class ?? "unknown"}: ${failure?.message ?? "request failed"}`,
    );
  }
  return { text: transcript.text, rawText: transcript.text };
}
