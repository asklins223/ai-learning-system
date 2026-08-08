/**
 * 任务 04-6：语音替代输入 —— Voice API 客户端收口（§6.5 + §13.4 + §13.2）。
 *
 * 对齐 `apps/api/src/modules/learning-sessions/voice-service.ts` 的函数语义
 * （transcribe / confirm / reRecord / switchModality），作为浏览器端唯一
 * 收口模块；组件层一律经注入回调间接使用本模块（见各组件注释），
 * 本模块自身也只被 learning-companion 组件与宿主页面调用。
 *
 * 端点路径（救火 6：与真实 API 路由对齐 voice-routes.ts）：
 *   POST /voice/transcribe
 *   POST /voice/confirm
 *   POST /voice/reRecord
 *   POST /voice/switchModality
 *
 * 请求义务（服务端 validateRequestObligations，§13.2）：
 *   每次写请求必须携带 base revision、public scene hash、user action nonce
 *   （8-128 字符）与 idempotency key；locked 后迟到的 autosave/chunk 一律拒绝。
 *   本模块提供 `createVoiceObligations` 生成 nonce + idempotency key，
 *   并镜像服务端做 fail-fast 校验。
 *
 * 数据治理（§13.2）：
 *   - confirm/reRecord/switchModality 走 audioRef/audioHash（上游 transient 上传
 *     管线：raw audio 短 TTL、加密、不进长期备份）；救火 6b 起 transcribe 直接
 *     上传音频 blob（FormData → /voice/transcribe，10MB 上限）；
 *   - 内容 hash 以服务端计算为准（fail closed）；本模块的
 *     `computeTextContentHashPreview` / `computeVoiceTranscriptHashPreview`
 *     仅供 UI 展示"确定性哈希绑定"语义，不作校验依据。
 *
 * Reduced-motion / A11y（§13.4）：本模块不持有任何动画/计时器逻辑；
 * UI 层（面板/输入组件）的动效随全局 `prefers-reduced-motion: reduce`
 * 禁用后静态呈现，信息不依赖动画。
 */

import {
  ApiError,
  API_URL,
  getCsrfToken,
  getToken,
} from "@/lib/api";
import type { VoicePayload } from "@ailearn/shared";

// ─── 请求义务 ─────────────────────────────────────────────────────────────

export interface VoiceObligations {
  /** 服务端 revision CAS：必须等于当前 artifact 的 revision */
  baseRevision: number;
  /** public scene hash（= FrozenProbeRef.publicPayloadHash），stale 判定 */
  publicSceneHash: string;
  /** user action nonce，8-128 字符（每次用户动作唯一） */
  userActionNonce: string;
  /** 幂等兜底 key（重试安全） */
  idempotencyKey: string;
}

/** 生成一次用户动作的 nonce（36 字符 UUID，满足 8-128 约束） */
export function createUserActionNonce(): string {
  if (typeof globalThis !== "undefined" && typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  // 极旧浏览器兜底（仅 nonce 用途，非安全边界）
  return `n-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * 生成一次写请求的义务载荷。
 * @param baseRevision   当前 artifact revision（CAS）
 * @param publicSceneHash publicPayloadHash（stale 判定）
 * @param scopeKey       幂等作用域（如 episodeId / keyPointId），保证同动作重试命中同一 key
 */
export function createVoiceObligations(
  baseRevision: number,
  publicSceneHash: string,
  scopeKey: string,
): VoiceObligations {
  const userActionNonce = createUserActionNonce();
  return {
    baseRevision,
    publicSceneHash,
    userActionNonce,
    idempotencyKey: `voice:${scopeKey}:${userActionNonce}`,
  };
}

/**
 * 客户端侧 fail-fast 校验（镜像服务端 validateRequestObligations）。
 * 返回错误信息数组；空数组表示通过。服务端仍会独立复核（fail closed）。
 */
export function validateVoiceObligations(obligations: VoiceObligations): string[] {
  const problems: string[] = [];
  if (!Number.isInteger(obligations.baseRevision) || obligations.baseRevision < 0) {
    problems.push("base revision 非法");
  }
  if (
    typeof obligations.publicSceneHash !== "string"
    || obligations.publicSceneHash.trim().length < 8
  ) {
    problems.push("public scene hash 缺失或过短");
  }
  if (
    typeof obligations.userActionNonce !== "string"
    || obligations.userActionNonce.length < 8
    || obligations.userActionNonce.length > 128
  ) {
    problems.push("user action nonce 必须为 8-128 字符");
  }
  if (
    typeof obligations.idempotencyKey !== "string"
    || obligations.idempotencyKey.trim() === ""
  ) {
    problems.push("idempotency key 缺失");
  }
  return problems;
}

// ─── 客户端 DTO（对齐 voice-service 语义；类型契约来源 @ailearn/shared）───

/** 确认前的 voice draft（无 confirmedAt；capturing/transcribed/awaiting_confirmation 阶段） */
export type VoiceDraftPayload = Omit<VoicePayload, "confirmedAt">;

export type TranscriptionOutcome =
  | { kind: "ok"; draft: VoiceDraftPayload; artifactId: string }
  | { kind: "not_assessable"; reason: string };

export interface ConfirmTranscriptBody {
  artifactId: string;
  /** 用户确认的逐字 transcript（必须与 ASR draft 逐字一致；不一致 → VOICE_CONFIRM_MISMATCH） */
  confirmedTranscript: string;
}

export interface ConfirmTranscriptResult {
  artifactId: string;
  status: "locked";
}

export interface ReRecordBody {
  probeId: string;
  episodeId: string;
  keyPointId: string;
  /** 被取代的前一条未锁定 artifact（locked 后重录 → ARTIFACT_LOCKED） */
  previousArtifactId: string;
  audioRef: string;
  audioHash: string;
}

export interface ReRecordResult {
  artifactId: string;
  status: "capturing";
}

export interface SwitchModalityBody {
  probeId: string;
  episodeId: string;
  keyPointId: string;
  /** 用户确认的原始文本（手工编辑 ASR transcript 或纯文字输入） */
  text: string;
  /** 被取代的来源 artifact（手工编辑 ASR transcript 时必填；纯文字用户可省略） */
  sourceArtifactId?: string;
}

export interface SwitchModalityResult {
  artifactId: string;
  modality: "text_or_mixed";
  status: "locked";
}

// ─── 收口 fetch 实现（复用 lib/api.ts 的鉴权/CSRF/错误体系）────────────────

// 救火 6：与真实 API 路由对齐（voice-routes.ts：POST /voice/tts、/voice/transcribe）
const VOICE_BASE_PATH = "/voice";

type VoiceActionBody =
  | ConfirmTranscriptBody
  | ReRecordBody
  | SwitchModalityBody;

interface VoiceRequestOptions {
  json?: VoiceActionBody;
  /** 救火 6b：multipart FormData（transcribe 上传音频；优先级高于 json） */
  form?: FormData;
}

async function voiceRequest<T>(
  action: string,
  obligations: VoiceObligations,
  options: VoiceRequestOptions,
): Promise<T> {
  const problems = validateVoiceObligations(obligations);
  if (problems.length > 0) {
    throw new ApiError(400, `请求义务不完整：${problems.join("；")}`, "INVALID_OBLIGATIONS");
  }
  const headers = new Headers();
  // 救火 6b：FormData 上传时浏览器自动设 multipart boundary——不手动 Content-Type；
  // JSON 路径设 application/json。oauth obligations 并入 JSON body。
  let body: BodyInit;
  if (options.form) {
    body = options.form;
  } else {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify({ ...options.json, ...obligations });
  }
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const csrf = getCsrfToken();
  if (csrf) headers.set("x-csrf-token", csrf);
  const res = await fetch(`${API_URL}${VOICE_BASE_PATH}/${action}`, {
    method: "POST",
    headers,
    credentials: "same-origin",
    body,
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    let code: string | undefined;
    try {
      const data = (await res.json()) as { error?: string; code?: string };
      if (typeof data?.error === "string" && data.error) message = data.error;
      code = data?.code;
    } catch {
      // 非 JSON 错误体，保留 statusText
    }
    throw new ApiError(res.status, message, code);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// ─── 语义收口（transcribe / confirm / reRecord / switchModality）───────────

export const voiceApi = {
  /**
   * ASR 转写（救火 6b 契约对齐）：multipart FormData 直接上传音频 blob，
   * 服务端 /voice/transcribe 收 file 字段（10MB 上限）→ SiliconFlow 识别。
   */
  transcribe(
    obligations: VoiceObligations,
    body: { audio: Blob; filename?: string; language?: string },
  ): Promise<TranscriptionOutcome> {
    const form = new FormData();
    form.append("file", body.audio, body.filename ?? "audio-upload.mp3");
    if (body.language) form.append("language", body.language);
    return voiceRequest<TranscriptionOutcome>("transcribe", obligations, { form });
  },

  /** 确认逐字 transcript → locked（voice canonical answer，§6.5） */
  confirmTranscript(
    obligations: VoiceObligations,
    body: ConfirmTranscriptBody,
  ): Promise<ConfirmTranscriptResult> {
    return voiceRequest<ConfirmTranscriptResult>("confirm", obligations, { json: body });
  },

  /** 重录：创建 superseding voice artifact（capturing），确认后仍属纯 voice */
  reRecord(
    obligations: VoiceObligations,
    body: ReRecordBody,
  ): Promise<ReRecordResult> {
    return voiceRequest<ReRecordResult>("reRecord", obligations, { json: body });
  },

  /** 换模态 / 手工修正：创建 text_or_mixed 新 Artifact 并 locked（§7.2） */
  switchModality(
    obligations: VoiceObligations,
    body: SwitchModalityBody,
  ): Promise<SwitchModalityResult> {
    return voiceRequest<SwitchModalityResult>("switchModality", obligations, { json: body });
  },
};

// ─── 确定性内容 hash 预览（仅 UI 展示；校验以服务端为准）──────────────────

/**
 * text_or_mixed 原始文本的确定性 hash 预览。
 * 与服务端 `computeTextContentHash` 同域（`text-or-mixed-v1:` 前缀），
 * 仅供界面展示"原始文本将绑定确定性 hash"语义；web crypto.subtle 仅在
 * 安全上下文可用（https / localhost），不可用时返回 null，界面降级为文字说明。
 */
export async function computeTextContentHashPreview(text: string): Promise<string | null> {
  return computePreviewHash(`text-or-mixed-v1:${text}`);
}

/** voice canonical transcript 的确定性 hash 预览（同服务端 `computeVoiceContentHash`） */
export async function computeVoiceTranscriptHashPreview(transcript: string): Promise<string | null> {
  return computePreviewHash(`voice-transcript-v1:${transcript}`);
}

async function computePreviewHash(domainData: string): Promise<string | null> {
  const subtle = typeof globalThis !== "undefined" ? globalThis.crypto?.subtle : undefined;
  if (!subtle) return null;
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(domainData));
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return `sha256:${hex}`;
}
