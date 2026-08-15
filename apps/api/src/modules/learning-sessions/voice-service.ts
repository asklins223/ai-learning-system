/**
 * 任务 04-1 / 04-2：TTS / ASR / transcript 确认 / 重录 / 换模态 与 Voice Artifact
 * 数据治理（§6.5 语音一等输入 + §7.2 模态 payload + §13.2 音频与 transcript 治理）。
 *
 * 冻结依据（04-w3 任务 04-1/04-2 + 冻结记录 01-2 §6/§6.2 + 01-4 §13.2）：
 * - TTS 只原样朗读净化题面：固定 voice/profile + 净化纯文本，不接受模型生成的
 *   SSML、远程音频 URL 或隐藏提示；口音/流利度/语速/停顿/音量不进入理解判定；
 * - ASR 生成逐字 transcript，用户可播放、确认、重录或切换模态；Agent 不能自动
 *   润色、概括或补全后再把结果当用户答案；关键术语低置信 → `not_assessable`，
 *   不能猜测（可无损重试）；
 * - 用户确认的逐字 transcript 是 voice artifact 的 canonical answer；重录确认仍为
 *   voice revision，手工修正则创建 `text_or_mixed` revision；两者服从同一 lock、
 *   stale、assistance 与删除规则；无麦克风用户始终可切换 `text_or_mixed`；
 * - `voice` payload：逐字 confirmed transcript、segment timestamps、ASR
 *   provider/model/version/language/confidence、可选短期 audio ref/hash；
 *   `text_or_mixed` payload：原始文本与 hash、`supersedesArtifactId` 保留来源；
 * - 每个 Artifact 必须逐 hash 匹配 Episode 的 `FrozenProbeRef`；只有 version 没有
 *   private solution/safety hash 不足以进入评估；
 * - raw audio 是短期 transient 输入（加密、短 TTL、不进长期备份）；确认后 raw audio
 *   丢失或到期不降低既有 trust；audio hash 不可恢复声音；
 * - ASR/TTS Provider 绑定 tenant policy、region、保留期、训练使用禁令与 consent
 *   version，不满足 workspace policy 时语音能力 fail closed；
 * - 音频、transcript、题面、答案不进入普通日志、Prometheus label 或 analytics
 *   payload（redactForLogs 供日志管线调用）；
 * - 请求必须携带 base revision、public scene hash、user action nonce 和 idempotency
 *   key；locked 后迟到 autosave/chunk 一律拒绝。
 *
 * 实现策略（沿用 session-service / exposure-service 的纯函数 + 可注入 Repository
 * 模式，便于 node:test 单测）：
 * - TTS/ASR 经可注入接口（TtsProvider / AsrProvider，单测用 mock）；
 * - 判定纯函数：assertSafeTtsInput / assessTranscriptionQuality /
 *   assertArtifactMatchesFrozenProbe / assertProviderPolicyCompliant 不依赖 DB；
 * - DB 交互全部走可注入的 VoiceArtifactRepository（内存实现可测）。
 *
 * 本模块 0 canonical write：不写掌握/schedule/Card 真值；effectiveTrustClass 由
 * 任务 04-3 在 lock 时计算（本模块 lock 仅冻结 artifact 状态与 canonical answer）。
 *
 * 注：类型契约单一来源在 `packages/shared/src/voice-artifact-contracts.ts`；主代理
 * 在 index.ts 收口后本文件应改为 `import type { ... } from "@ailearn/shared"`。
 */

import { randomUUID } from "node:crypto";
import { TrustClass } from "@ailearn/shared";
import type { FrozenProbeRef } from "@ailearn/shared";

// ─── 类型（与 packages/shared voice-artifact-contracts.ts 同步的本地声明，
//      收口后迁移到 @ailearn/shared）──────────────────────────────────────

export interface TranscriptSegment {
  startMs: number;
  endMs: number;
  text: string;
  confidence: number;
}

/** voice 模态 payload（§7.2）：confirmedAt = 用户确认时间 */
export interface VoicePayload {
  confirmedTranscript: string;
  segmentTimestamps: TranscriptSegment[];
  asrProvider: string;
  asrModel: string;
  asrVersion: string;
  language: string;
  confidence: number;
  audioRef?: string;
  audioHash?: string;
  confirmedAt: string;
}

/** 确认前的 voice draft（无 confirmedAt；capturing/transcribed/awaiting_confirmation 阶段） */
export type DraftVoicePayload = Omit<VoicePayload, "confirmedAt">;

/** text_or_mixed 模态 payload（§7.2） */
export interface TextOrMixedPayload {
  text: string;
  contentHash: string;
  supersedesArtifactId?: string;
}

/** ASR/TTS Provider 数据治理（§13.2） */
export interface ASRProviderPolicy {
  tenantPolicyRef: string;
  region: string;
  retentionDays: number;
  trainingUseProhibited: boolean;
  consentVersion: string;
}

export type ArtifactModality = "voice" | "text_or_mixed";

/** 状态机（01-2 §6.2）：capturing → transcribed → awaiting_confirmation → locked | superseded | stale */
export type ArtifactStatus =
  | "capturing"
  | "transcribed"
  | "awaiting_confirmation"
  | "locked"
  | "superseded"
  | "stale"
  | "redacted";

export type CorrectionMethod = "none" | "re_recorded" | "manual_text_edit";

export type ArtifactPayload = DraftVoicePayload | TextOrMixedPayload;

/** Voice Artifact 最小记录（对应 learning_response_artifacts 表 + FrozenProbeRef 引用） */
export interface VoiceArtifactRecord {
  id: string;
  workspaceId: string;
  userId: string;
  episodeId: string;
  keyPointId: string;
  probeId: string;
  publicSceneContractId: string;
  publicPayloadHash: string;
  privateSolutionId: string;
  privateSolutionHash: string;
  sceneSafetyReportHash: string;
  disclosureProfileHash: string;
  inputSchemaHash: string;
  modality: ArtifactModality;
  contentHash: string;
  payload: ArtifactPayload;
  status: ArtifactStatus;
  revision: number;
  supersedesArtifactId: string | null;
  correctionMethod: CorrectionMethod | null;
  answerLockedAt: string | null;
  episodeTargetFingerprint: string;
  contentExposureKey: string;
  requestedTrustClass: TrustClass;
  templateTrustCeiling: TrustClass;
  effectiveTrustClass: TrustClass | null;
  trustPolicyVersion: string;
  trustReasonCodes: string[];
}

// ─── 可注入 Provider 接口（单测用 mock）──────────────────────────────────

export interface TtsSynthesisRequest {
  /** 净化题面纯文本（原样朗读，无 SSML/URL/提示） */
  text: string;
  /** 固定 voice/profile id（allowlist 内） */
  voiceProfile: string;
  language: string;
  requestId: string;
}

export interface TtsSynthesisResult {
  /** 短期 raw audio 引用（短 TTL、加密存储） */
  audioRef: string;
  audioHash: string;
  expiresAt: string;
}

export interface TtsProvider {
  synthesize(request: TtsSynthesisRequest): Promise<TtsSynthesisResult>;
}

export interface AsrTranscriptionRequest {
  audioRef: string;
  audioHash: string;
  language: string;
  requestId: string;
}

export interface AsrTranscriptionResult {
  /** 逐字 transcript（canonical answer 的候选；不润色不补全） */
  transcript: string;
  segments: TranscriptSegment[];
  /** provider 标记的低置信 token（逐词；命中关键术语 → not_assessable） */
  lowConfidenceTokens: string[];
  asrProvider: string;
  asrModel: string;
  asrVersion: string;
}

export interface AsrProvider {
  transcribe(request: AsrTranscriptionRequest): Promise<AsrTranscriptionResult>;
}

// ─── workspace voice policy（Provider 数据治理的参照面）───────────────────

export interface WorkspaceVoicePolicy {
  tenantPolicyRef: string;
  allowedRegions: string[];
  /** 要求的最短数据保留期（天）；不足 → fail closed */
  minRetentionDays: number;
  /** workspace 是否强制训练使用禁令 */
  trainingUseProhibited: boolean;
  currentConsentVersion: string;
}

// ─── 错误 ────────────────────────────────────────────────────────────────

export type VoiceServiceErrorCode =
  | "INVALID_ARGUMENT"
  | "INVALID_NONCE"
  | "STALE_REVISION"
  | "TTS_INPUT_UNSAFE"
  | "PROVIDER_POLICY_VIOLATION"
  | "FROZEN_PROBE_MISMATCH"
  | "ARTIFACT_LOCKED"
  | "VOICE_CONFIRM_MISMATCH";

export class VoiceServiceError extends Error {
  readonly code: VoiceServiceErrorCode;

  constructor(message: string, code: VoiceServiceErrorCode) {
    super(message);
    this.name = "VoiceServiceError";
    this.code = code;
  }
}

// ─── 常量 ────────────────────────────────────────────────────────────────

/** 固定 voice/profile 的唯一 allowlist（TTS 只使用审核过的固定 profile，§6.5） */
export const DEFAULT_VOICE_PROFILE = "companion-default-v1";
const ALLOWED_VOICE_PROFILES: ReadonlySet<string> = new Set(["companion-default-v1"]);

export const DEFAULT_MIN_SEGMENT_CONFIDENCE = 0.6;
export const DEFAULT_MIN_OVERALL_CONFIDENCE = 0.5;

// ─── 请求义务校验（base revision / public scene hash / nonce / idempotency key）─

export interface RequestObligations {
  baseRevision: number;
  publicSceneHash: string;
  userActionNonce: string;
  idempotencyKey: string;
}

/**
 * 每个写请求必须携带四项（01-2 §6.2）：
 * - base revision（revision CAS）；- public scene hash（= publicPayloadHash）；
 * - user action nonce（8-128 字符）；- idempotency key（幂等兜底）。
 */
export function validateRequestObligations(input: RequestObligations): void {
  if (!Number.isInteger(input.baseRevision) || input.baseRevision < 0) {
    throw new VoiceServiceError("base revision 非法", "INVALID_ARGUMENT");
  }
  if (typeof input.publicSceneHash !== "string" || input.publicSceneHash.trim().length < 8) {
    throw new VoiceServiceError("public scene hash 缺失或过短", "INVALID_ARGUMENT");
  }
  if (
    typeof input.userActionNonce !== "string"
    || input.userActionNonce.length < 8
    || input.userActionNonce.length > 128
  ) {
    throw new VoiceServiceError(
      "user action nonce 必须为 8-128 字符的字符串",
      "INVALID_NONCE",
    );
  }
  if (typeof input.idempotencyKey !== "string" || input.idempotencyKey.trim() === "") {
    throw new VoiceServiceError("idempotency key 缺失", "INVALID_ARGUMENT");
  }
}

// ─── Provider 数据治理：workspace policy 不满足 → fail closed（§13.2）─────

export function assertProviderPolicyCompliant(
  policy: ASRProviderPolicy,
  workspace: WorkspaceVoicePolicy,
): void {
  const failures: string[] = [];
  if (policy.tenantPolicyRef !== workspace.tenantPolicyRef) {
    failures.push(
      `tenantPolicyRef 失配：${policy.tenantPolicyRef} !== ${workspace.tenantPolicyRef}`,
    );
  }
  if (!workspace.allowedRegions.includes(policy.region)) {
    failures.push(`region 不在 workspace 允许列表：${policy.region}`);
  }
  if (policy.retentionDays < workspace.minRetentionDays) {
    failures.push(
      `retentionDays ${policy.retentionDays} < workspace 最小 ${workspace.minRetentionDays}`,
    );
  }
  if (workspace.trainingUseProhibited && !policy.trainingUseProhibited) {
    failures.push("trainingUseProhibited 必须为 true（workspace 训练禁令）");
  }
  if (policy.consentVersion !== workspace.currentConsentVersion) {
    failures.push(
      `consentVersion 失配：${policy.consentVersion} !== ${workspace.currentConsentVersion}`,
    );
  }
  if (failures.length > 0) {
    throw new VoiceServiceError(
      `Provider policy 不满足 workspace policy，语音能力 fail closed：${failures.join("；")}`,
      "PROVIDER_POLICY_VIOLATION",
    );
  }
}

// ─── TTS 输入安全（§6.5：只朗读净化题面）──────────────────────────────────

const SSML_TAG_RE = /<\/?[a-zA-Z][a-zA-Z0-9]*(?:\s[^>]*)?\s*>/;
const REMOTE_URL_RE = /\bhttps?:\/\/\S+/i;
/** 隐藏提示/关键词暗示（fail closed 安全网；净化主要发生在上游 Scene activation） */
const HIDDEN_PROMPT_RE =
  /(?:\[system\]|\[assistant\]|<\|im_start\|)|ignore\s+(?:previous|above|prior)|^\s*(?:system|assistant)\s*[:：]|(?:忽略|忘记)(?:上面|以上|之前).{0,8}(?:内容|指令|话)|(?:直接|请).{0,6}(?:告诉|提示|说出).{0,4}(?:答案|关键词)/im;

/**
 * TTS 输入安全校验（§6.5）：只接受净化纯文本 + 固定 voice/profile。
 * - 任何 SSML/XML 标签（含 `<speak>/<break>/<prosody>` 等）→ 拒绝；
 * - 任何远程音频 URL → 拒绝；
 * - 隐藏提示/关键词暗示 → 拒绝；
 * - voice/profile 不在固定 allowlist → 拒绝。
 */
export function assertSafeTtsInput(text: string, voiceProfile: string): void {
  if (typeof text !== "string" || text.trim() === "") {
    throw new VoiceServiceError("TTS 输入为空", "TTS_INPUT_UNSAFE");
  }
  if (SSML_TAG_RE.test(text)) {
    throw new VoiceServiceError("TTS 输入包含 SSML/XML 标签，拒绝", "TTS_INPUT_UNSAFE");
  }
  if (REMOTE_URL_RE.test(text)) {
    throw new VoiceServiceError("TTS 输入包含远程音频 URL，拒绝", "TTS_INPUT_UNSAFE");
  }
  if (HIDDEN_PROMPT_RE.test(text)) {
    throw new VoiceServiceError("TTS 输入包含隐藏提示/关键词暗示，拒绝", "TTS_INPUT_UNSAFE");
  }
  if (!ALLOWED_VOICE_PROFILES.has(voiceProfile)) {
    throw new VoiceServiceError(
      `voice/profile 不在固定 allowlist：${voiceProfile}`,
      "TTS_INPUT_UNSAFE",
    );
  }
}

// ─── TTS：朗读净化题面 ────────────────────────────────────────────────────

export interface TtsReadAloudOptions {
  /** 净化题面纯文本（TTS 只原样朗读此文本） */
  text: string;
  provider: TtsProvider;
  providerPolicy: ASRProviderPolicy;
  workspacePolicy: WorkspaceVoicePolicy;
  language: string;
  voiceProfile?: string;
  requestId: string;
}

/**
 * TTS 主入口：校验 Provider policy（fail closed）→ 校验净化题面安全（拒绝
 * SSML/URL/隐藏提示/非法 voice）→ 调 provider 原样合成。
 * 口音、流利度、语速、停顿、音量不是本函数输入，也不进入任何理解判定（§6.5）。
 */
export async function ttsReadAloud(options: TtsReadAloudOptions): Promise<TtsSynthesisResult> {
  assertProviderPolicyCompliant(options.providerPolicy, options.workspacePolicy);
  const voiceProfile = options.voiceProfile ?? DEFAULT_VOICE_PROFILE;
  assertSafeTtsInput(options.text, voiceProfile);
  return options.provider.synthesize({
    text: options.text,
    voiceProfile,
    language: options.language,
    requestId: options.requestId,
  });
}

// ─── ASR 质量评估（关键术语低置信 → not_assessable，不猜测）────────────────

export interface TranscriptionQualityOptions {
  /** 关键术语（来自净化题面中出现的领域术语；公开可提供，不来自 secret solution） */
  criticalTerms: string[];
  language: string;
  minSegmentConfidence: number;
  minOverallConfidence: number;
}

export type TranscriptionOutcome =
  | { kind: "ok"; draft: DraftVoicePayload }
  | {
      kind: "not_assessable";
      reason: string;
      reasonCode: "critical_term_low_confidence" | "overall_low_confidence";
    };

function normalizeToken(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * ASR 质量判定（纯函数，§6.5/§13.2）：
 * - 关键术语低置信 → `not_assessable`（不猜测，可无损重试）；
 * - 整体（逐段最低）置信度过低 → `not_assessable`；
 * - 口音/流利度/语速/停顿/音量不在输入内，不进入判定；
 * - 通过 → 构造 voice draft（confirmedTranscript 为逐字原样，无 confirmedAt）。
 */
export function assessTranscriptionQuality(
  result: AsrTranscriptionResult,
  options: TranscriptionQualityOptions,
): TranscriptionOutcome {
  if (result.segments.length === 0 || result.transcript.trim() === "") {
    return {
      kind: "not_assessable",
      reason: "ASR 未产生任何可辨认内容",
      reasonCode: "overall_low_confidence",
    };
  }
  const critical = [...new Set(options.criticalTerms.map(normalizeToken).filter((t) => t !== ""))];
  const criticalSet = new Set(critical);
  const minSeg = options.minSegmentConfidence;
  const minOverall = options.minOverallConfidence;

  let overall = 1;
  for (const seg of result.segments) {
    overall = Math.min(overall, seg.confidence);
    if (seg.confidence < minSeg) {
      const segText = normalizeToken(seg.text);
      if (critical.some((term) => segText.includes(term))) {
        return {
          kind: "not_assessable",
          reason: `关键术语低置信：segment「${seg.text}」置信度 ${seg.confidence}`,
          reasonCode: "critical_term_low_confidence",
        };
      }
    }
  }
  for (const token of result.lowConfidenceTokens) {
    if (criticalSet.has(normalizeToken(token))) {
      return {
        kind: "not_assessable",
        reason: `关键术语低置信 token：${token}`,
        reasonCode: "critical_term_low_confidence",
      };
    }
  }
  if (overall < minOverall) {
    return {
      kind: "not_assessable",
      reason: `整体 ASR 置信度过低：${overall}`,
      reasonCode: "overall_low_confidence",
    };
  }
  return {
    kind: "ok",
    draft: {
      confirmedTranscript: result.transcript,
      segmentTimestamps: result.segments,
      asrProvider: result.asrProvider,
      asrModel: result.asrModel,
      asrVersion: result.asrVersion,
      language: options.language,
      confidence: overall,
    },
  };
}

// ─── ASR：transcribe（provider 可注入 mock；policy 不满足 fail closed）─────

export interface TranscribeOptions {
  audioRef: string;
  audioHash: string;
  language: string;
  provider: AsrProvider;
  providerPolicy: ASRProviderPolicy;
  workspacePolicy: WorkspaceVoicePolicy;
  criticalTerms: string[];
  minSegmentConfidence?: number;
  minOverallConfidence?: number;
  requestId: string;
}

export async function transcribe(options: TranscribeOptions): Promise<TranscriptionOutcome> {
  assertProviderPolicyCompliant(options.providerPolicy, options.workspacePolicy);
  const result = await options.provider.transcribe({
    audioRef: options.audioRef,
    audioHash: options.audioHash,
    language: options.language,
    requestId: options.requestId,
  });
  const outcome = assessTranscriptionQuality(result, {
    criticalTerms: options.criticalTerms,
    language: options.language,
    minSegmentConfidence: options.minSegmentConfidence ?? DEFAULT_MIN_SEGMENT_CONFIDENCE,
    minOverallConfidence: options.minOverallConfidence ?? DEFAULT_MIN_OVERALL_CONFIDENCE,
  });
  if (outcome.kind === "not_assessable") {
    // 无正负副作用，可无损重试（§6.5 / 01-4 §13.5）
    return outcome;
  }
  return {
    kind: "ok",
    draft: {
      ...outcome.draft,
      audioRef: options.audioRef,
      audioHash: options.audioHash,
    },
  };
}

// ─── 哈希工具（确定性内容哈希）────────────────────────────────────────────
// 单一来源：packages/shared/src/content-hash.ts（security_review HIGH #2 修复——
// voice-service 与 assessment-critic 必须引用同一实现，避免格式断裂）。
import { computeVoiceContentHash, computeTextContentHash } from "@ailearn/shared/content-hash";
export { computeVoiceContentHash, computeTextContentHash } from "@ailearn/shared/content-hash";

// ─── FrozenProbe 逐 hash 绑定（§7.2）─────────────────────────────────────

/**
 * 每个 Artifact 必须逐 hash 匹配 Episode 的 FrozenProbeRef：
 * probeId / publicSceneContractId / publicPayloadHash / privateSolutionId /
 * privateSolutionHash / sceneSafetyReportHash / disclosureProfileHash /
 * templateTrustCeiling。任一失配 → fail closed（不可进入评估；
 * 只有 version 没有 private solution/safety hash 不足以进入评估）。
 */
export function assertArtifactMatchesFrozenProbe(
  artifact: VoiceArtifactRecord,
  frozenProbe: FrozenProbeRef,
): void {
  const pairs: ReadonlyArray<readonly [string, string, string]> = [
    ["probeId", artifact.probeId, frozenProbe.probeId],
    ["publicSceneContractId", artifact.publicSceneContractId, frozenProbe.publicSceneContractId],
    ["publicPayloadHash", artifact.publicPayloadHash, frozenProbe.publicPayloadHash],
    ["privateSolutionId", artifact.privateSolutionId, frozenProbe.privateSolutionId],
    ["privateSolutionHash", artifact.privateSolutionHash, frozenProbe.privateSolutionHash],
    ["sceneSafetyReportHash", artifact.sceneSafetyReportHash, frozenProbe.sceneSafetyReportHash],
    ["disclosureProfileHash", artifact.disclosureProfileHash, frozenProbe.disclosureProfileHash],
    ["templateTrustCeiling", artifact.templateTrustCeiling, frozenProbe.templateTrustCeiling],
  ];
  const mismatches = pairs
    .filter(([, artifactValue, probeValue]) => artifactValue !== probeValue)
    .map(([name, artifactValue, probeValue]) => `${name}: ${artifactValue} !== ${probeValue}`);
  if (mismatches.length > 0) {
    throw new VoiceServiceError(
      `artifact 与 FrozenProbeRef 逐 hash 失配：${mismatches.join("；")}`,
      "FROZEN_PROBE_MISMATCH",
    );
  }
}

// ─── 可注入 Repository ───────────────────────────────────────────────────

export interface ArtifactPatch {
  status?: ArtifactStatus;
  answerLockedAt?: string | null;
  payload?: ArtifactPayload;
  contentHash?: string;
  effectiveTrustClass?: TrustClass | null;
  supersedesArtifactId?: string | null;
  correctionMethod?: CorrectionMethod | null;
}

export interface VoiceArtifactRepository {
  findArtifact(
    workspaceId: string,
    userId: string,
    artifactId: string,
  ): Promise<VoiceArtifactRecord | null>;
  findFrozenProbe(
    workspaceId: string,
    userId: string,
    probeId: string,
  ): Promise<FrozenProbeRef | null>;
  /** 取 episode 级事实（episodeTargetFingerprint / contentExposureKey）：
   *  无来源路径的 artifact 必须用服务端 episode 值，不能写成空串导致
   *  commit stale 判定与 FrozenProbe 匹配失真。 */
  findEpisodeSummary(
    workspaceId: string,
    userId: string,
    episodeId: string,
  ): Promise<{ episodeTargetFingerprint: string; contentExposureKey: string } | null>;
  createArtifact(record: VoiceArtifactRecord): Promise<VoiceArtifactRecord>;
  /** CAS 写回：revision 必须等于 expectedRevision，否则抛 STALE_REVISION */
  updateArtifact(
    workspaceId: string,
    userId: string,
    artifactId: string,
    expectedRevision: number,
    patch: ArtifactPatch,
  ): Promise<VoiceArtifactRecord>;
  listByProbe(workspaceId: string, userId: string, probeId: string): Promise<VoiceArtifactRecord[]>;
}

// ─── 请求上下文 ──────────────────────────────────────────────────────────

export interface VoiceArtifactContext {
  workspaceId: string;
  userId: string;
  repository: VoiceArtifactRepository;
}

async function requireArtifact(
  context: VoiceArtifactContext,
  artifactId: string,
): Promise<VoiceArtifactRecord> {
  const artifact = await context.repository.findArtifact(
    context.workspaceId,
    context.userId,
    artifactId,
  );
  if (artifact === null) {
    throw new VoiceServiceError("artifact 不存在", "INVALID_ARGUMENT");
  }
  return artifact;
}

async function requireFrozenProbe(
  context: VoiceArtifactContext,
  artifact: VoiceArtifactRecord,
): Promise<FrozenProbeRef> {
  const probe = await context.repository.findFrozenProbe(
    context.workspaceId,
    context.userId,
    artifact.probeId,
  );
  if (probe === null) {
    throw new VoiceServiceError("FrozenProbeRef 不存在，无法进入评估", "FROZEN_PROBE_MISMATCH");
  }
  assertArtifactMatchesFrozenProbe(artifact, probe);
  return probe;
}

function isDraftVoicePayload(payload: ArtifactPayload): payload is DraftVoicePayload {
  return (
    "confirmedTranscript" in payload
    && "segmentTimestamps" in payload
    && !("text" in payload)
  );
}

function isTextOrMixedPayload(payload: ArtifactPayload): payload is TextOrMixedPayload {
  return "text" in payload && "contentHash" in payload;
}

// ─── 确认逐字 transcript（voice canonical answer）────────────────────────

export interface ConfirmTranscriptInput extends RequestObligations {
  artifactId: string;
  /** 用户确认的逐字 transcript（必须与 ASR draft 逐字一致；不一致 → 拒绝并引导换模态） */
  confirmedTranscript: string;
  now?: Date;
}

/**
 * 确认 transcript（§6.5）：
 * - 用户确认的逐字 transcript 是 voice artifact 的 canonical answer；
 * - 确认文本与 ASR 逐字 draft 必须完全一致 —— Agent 不能自动润色、概括或补全后
 *   再把结果当用户答案；若用户手工修正，则必须走 switchModality（text_or_mixed）；
 * - 确认前逐 hash 校验 FrozenProbeRef（fail closed）；
 * - 状态 → locked、answerLockedAt/confirmedAt 冻结；不原地改写已哈希行
 *   （新 revision 一律走 reRecord / switchModality 创建 superseding artifact）。
 */
export async function confirmTranscript(
  context: VoiceArtifactContext,
  input: ConfirmTranscriptInput,
): Promise<VoiceArtifactRecord> {
  validateRequestObligations(input);
  const now = input.now ?? new Date();
  const artifact = await requireArtifact(context, input.artifactId);
  if (artifact.status === "locked") {
    throw new VoiceServiceError("artifact 已锁定，不能重复确认", "ARTIFACT_LOCKED");
  }
  if (artifact.revision !== input.baseRevision) {
    throw new VoiceServiceError(
      `base revision 失配：base=${input.baseRevision}，当前=${artifact.revision}`,
      "STALE_REVISION",
    );
  }
  if (artifact.publicPayloadHash !== input.publicSceneHash) {
    throw new VoiceServiceError("public scene hash 失配（stale）", "STALE_REVISION");
  }
  if (artifact.modality !== "voice" || !isDraftVoicePayload(artifact.payload)) {
    throw new VoiceServiceError("只有未锁定的 voice artifact 可确认 transcript", "INVALID_ARGUMENT");
  }
  // 逐字原样确认；不一致 = 润色/修正 → 不能伪装为纯 voice（§6.5 / §7.2）
  if (artifact.payload.confirmedTranscript !== input.confirmedTranscript) {
    throw new VoiceServiceError(
      "确认文本与 ASR 逐字 transcript 不一致：不能把润色/修正后的文本按纯 voice 确认；"
        + "请通过 switchModality 创建 text_or_mixed revision",
      "VOICE_CONFIRM_MISMATCH",
    );
  }
  await requireFrozenProbe(context, artifact);
  const contentHash = computeVoiceContentHash(input.confirmedTranscript);
  if (artifact.contentHash !== contentHash) {
    throw new VoiceServiceError("content hash 与确认文本不一致，拒绝锁定", "INVALID_ARGUMENT");
  }
  const confirmedPayload: VoicePayload = {
    ...artifact.payload,
    confirmedAt: now.toISOString(),
  };
  return context.repository.updateArtifact(
    context.workspaceId,
    context.userId,
    artifact.id,
    artifact.revision,
    {
      status: "locked",
      answerLockedAt: now.toISOString(),
      payload: confirmedPayload,
      // 原样确认 = none；重录链路（re_recorded）确认后仍保留 re_recorded（§7.2）
      correctionMethod: artifact.correctionMethod ?? "none",
    },
  );
}

// ─── 提交 ASR 草稿（transcribed → awaiting_confirmation）──────────────────

export interface SubmitTranscriptDraftInput extends RequestObligations {
  artifactId: string;
  draft: DraftVoicePayload;
}

/** 把 transcribe 得到的逐字 draft 落到 artifact（awaiting_confirmation），供用户确认。 */
export async function submitTranscriptDraft(
  context: VoiceArtifactContext,
  input: SubmitTranscriptDraftInput,
): Promise<VoiceArtifactRecord> {
  validateRequestObligations(input);
  const artifact = await requireArtifact(context, input.artifactId);
  if (artifact.status === "locked") {
    throw new VoiceServiceError("artifact 已锁定，迟到的 ASR draft 一律拒绝", "ARTIFACT_LOCKED");
  }
  if (artifact.revision !== input.baseRevision) {
    throw new VoiceServiceError(
      `base revision 失配：base=${input.baseRevision}，当前=${artifact.revision}`,
      "STALE_REVISION",
    );
  }
  if (artifact.publicPayloadHash !== input.publicSceneHash) {
    throw new VoiceServiceError("public scene hash 失配（stale）", "STALE_REVISION");
  }
  if (artifact.modality !== "voice") {
    throw new VoiceServiceError("只有 voice artifact 可提交 ASR 草稿", "INVALID_ARGUMENT");
  }
  return context.repository.updateArtifact(
    context.workspaceId,
    context.userId,
    artifact.id,
    artifact.revision,
    {
      status: "awaiting_confirmation",
      payload: input.draft,
      contentHash: computeVoiceContentHash(input.draft.confirmedTranscript),
    },
  );
}

// ─── 追加 chunk（locked 后迟到 chunk 一律拒绝）────────────────────────────

export interface AppendChunkInput extends RequestObligations {
  artifactId: string;
  segment: TranscriptSegment;
}

/**
 * 追加录音 chunk（autosave/分段上传）。锁定后一律拒绝（01-2 §6.2：
 * "locked 后迟到 autosave/chunk 一律拒绝"）。
 */
export async function appendChunk(
  context: VoiceArtifactContext,
  input: AppendChunkInput,
): Promise<VoiceArtifactRecord> {
  validateRequestObligations(input);
  const artifact = await requireArtifact(context, input.artifactId);
  if (artifact.status === "locked") {
    throw new VoiceServiceError(
      "artifact 已锁定，迟到的 chunk/autosave 一律拒绝",
      "ARTIFACT_LOCKED",
    );
  }
  if (artifact.revision !== input.baseRevision) {
    throw new VoiceServiceError(
      `base revision 失配：base=${input.baseRevision}，当前=${artifact.revision}`,
      "STALE_REVISION",
    );
  }
  if (artifact.publicPayloadHash !== input.publicSceneHash) {
    throw new VoiceServiceError("public scene hash 失配（stale）", "STALE_REVISION");
  }
  if (artifact.modality !== "voice" || !isDraftVoicePayload(artifact.payload)) {
    throw new VoiceServiceError("只有 voice artifact 可追加 chunk", "INVALID_ARGUMENT");
  }
  if (artifact.status === "capturing" && input.segment.startMs < 0) {
    throw new VoiceServiceError("chunk segment 时间戳非法", "INVALID_ARGUMENT");
  }
  const segments = [...artifact.payload.segmentTimestamps, input.segment];
  const transcript = artifact.payload.confirmedTranscript + input.segment.text;
  const nextStatus: ArtifactStatus =
    artifact.status === "capturing" ? "transcribed" : artifact.status;
  return context.repository.updateArtifact(
    context.workspaceId,
    context.userId,
    artifact.id,
    artifact.revision,
    {
      status: nextStatus,
      payload: { ...artifact.payload, confirmedTranscript: transcript, segmentTimestamps: segments },
      contentHash: computeVoiceContentHash(transcript),
    },
  );
}

// ─── 重录（新 voice revision，确认后仍为纯 voice）─────────────────────────

export interface ReRecordInput extends RequestObligations {
  probeId: string;
  episodeId: string;
  keyPointId: string;
  previousArtifactId: string;
  audioRef: string;
  audioHash: string;
  now?: Date;
}

/**
 * 重录（§6.5/§7.2）：创建新 voice artifact（capturing），supersedes 前一条未锁定
 * artifact；新录制的音频经 transcribe → submitTranscriptDraft → confirmTranscript
 * 后仍属纯 voice（correctionMethod="re_recorded"）。
 * - 前一条已 locked → 拒绝（locked 后不可重录）；
 * - 新 artifact 继承同一 probe 的 FrozenProbe 引用（逐 hash 校验）；
 * - 不原地修改已哈希行。
 */
export async function reRecord(
  context: VoiceArtifactContext,
  input: ReRecordInput,
): Promise<VoiceArtifactRecord> {
  validateRequestObligations(input);
  const previous = await requireArtifact(context, input.previousArtifactId);
  if (previous.probeId !== input.probeId) {
    throw new VoiceServiceError("previous artifact 不属于当前 probe", "INVALID_ARGUMENT");
  }
  if (previous.status === "locked") {
    throw new VoiceServiceError("artifact 已锁定，不能重录（locked 后迟到输入一律拒绝）", "ARTIFACT_LOCKED");
  }
  if (previous.revision !== input.baseRevision) {
    throw new VoiceServiceError(
      `base revision 失配：base=${input.baseRevision}，当前=${previous.revision}`,
      "STALE_REVISION",
    );
  }
  if (previous.publicPayloadHash !== input.publicSceneHash) {
    throw new VoiceServiceError("public scene hash 失配（stale）", "STALE_REVISION");
  }
  await requireFrozenProbe(context, previous);

  const superseding: VoiceArtifactRecord = {
    id: randomUUID(),
    workspaceId: context.workspaceId,
    userId: context.userId,
    episodeId: input.episodeId,
    keyPointId: input.keyPointId,
    probeId: input.probeId,
    publicSceneContractId: previous.publicSceneContractId,
    publicPayloadHash: previous.publicPayloadHash,
    privateSolutionId: previous.privateSolutionId,
    privateSolutionHash: previous.privateSolutionHash,
    sceneSafetyReportHash: previous.sceneSafetyReportHash,
    disclosureProfileHash: previous.disclosureProfileHash,
    inputSchemaHash: previous.inputSchemaHash,
    modality: "voice",
    contentHash: computeVoiceContentHash(""),
    payload: {
      confirmedTranscript: "",
      segmentTimestamps: [],
      asrProvider: "",
      asrModel: "",
      asrVersion: "",
      language: "",
      confidence: 0,
      audioRef: input.audioRef,
      audioHash: input.audioHash,
    },
    status: "capturing",
    revision: previous.revision + 1,
    supersedesArtifactId: previous.id,
    correctionMethod: "re_recorded",
    answerLockedAt: null,
    episodeTargetFingerprint: previous.episodeTargetFingerprint,
    contentExposureKey: previous.contentExposureKey,
    requestedTrustClass: previous.requestedTrustClass,
    templateTrustCeiling: previous.templateTrustCeiling,
    effectiveTrustClass: null,
    trustPolicyVersion: previous.trustPolicyVersion,
    trustReasonCodes: [],
  };

  const created = await context.repository.createArtifact(superseding);
  await context.repository.updateArtifact(
    context.workspaceId,
    context.userId,
    previous.id,
    previous.revision,
    { status: "superseded" },
  );
  return created;
}

// ─── 换模态 / 手工修正（text_or_mixed revision）───────────────────────────

export interface SwitchModalityInput extends RequestObligations {
  probeId: string;
  episodeId: string;
  keyPointId: string;
  /**
   * 被取代的来源 artifact（手工编辑 ASR transcript 时必须提供，supersedes 保留来源）；
   * 无麦克风/从零开始的纯文字用户可不提供（无来源，revision 0 起）。
   */
  sourceArtifactId?: string;
  /** 用户确认的原始文本（手工编辑 ASR transcript 或纯文字输入） */
  text: string;
  now?: Date;
}

/**
 * 切换 text_or_mixed（§6.5/§7.2）：
 * - 手工编辑 ASR transcript 或纯文字输入 → 创建 text_or_mixed 新 Artifact；
 * - `supersedesArtifactId` 保留来源，不伪装为纯 voice；correctionMethod="manual_text_edit"；
 * - 无麦克风、安静环境或言语障碍用户始终可切换此 canonical 输入；
 * - 用户手工输入文本即最终表达，创建即 locked（与 voice 的"确认→lock"等价，
 *   都服从同一 lock/stale/assistance/删除规则）；锁定后不可原地改写。
 */
export async function switchModality(
  context: VoiceArtifactContext,
  input: SwitchModalityInput,
): Promise<VoiceArtifactRecord> {
  validateRequestObligations(input);
  const now = input.now ?? new Date();
  if (typeof input.text !== "string" || input.text.trim() === "") {
    throw new VoiceServiceError("text_or_mixed 文本不能为空", "INVALID_ARGUMENT");
  }
  const contentHash = computeTextContentHash(input.text);

  // FrozenProbe 逐 hash 绑定（§7.2）：无论有/无来源，artifact 必须逐 hash 匹配
  // 服务端冻结事实；无来源路径同样绑定（不采信客户端提交的 hash 值）。
  const frozenProbe = await context.repository.findFrozenProbe(
    context.workspaceId,
    context.userId,
    input.probeId,
  );
  if (frozenProbe === null) {
    throw new VoiceServiceError("FrozenProbeRef 不存在，无法进入评估", "FROZEN_PROBE_MISMATCH");
  }

  // 有来源（手工编辑 ASR transcript）：supersede 来源 artifact 并继承其 probe 引用。
  let source: VoiceArtifactRecord | null = null;
  let episodeSummary: { episodeTargetFingerprint: string; contentExposureKey: string } | null = null;
  if (input.sourceArtifactId !== undefined) {
    source = await requireArtifact(context, input.sourceArtifactId);
    if (source.probeId !== input.probeId) {
      throw new VoiceServiceError("source artifact 不属于当前 probe", "INVALID_ARGUMENT");
    }
    if (source.status === "locked") {
      throw new VoiceServiceError("artifact 已锁定，不能切换模态", "ARTIFACT_LOCKED");
    }
    if (source.revision !== input.baseRevision) {
      throw new VoiceServiceError(
        `base revision 失配：base=${input.baseRevision}，当前=${source.revision}`,
        "STALE_REVISION",
      );
    }
    if (source.publicPayloadHash !== input.publicSceneHash) {
      throw new VoiceServiceError("public scene hash 失配（stale）", "STALE_REVISION");
    }
    await requireFrozenProbe(context, source);
  } else {
    // 无来源路径：episode 级事实取自服务端 episode 行（不采信客户端值）。
    episodeSummary = await context.repository.findEpisodeSummary(
      context.workspaceId,
      context.userId,
      input.episodeId,
    );
  }

  const artifact: VoiceArtifactRecord = {
    id: randomUUID(),
    workspaceId: context.workspaceId,
    userId: context.userId,
    episodeId: input.episodeId,
    keyPointId: input.keyPointId,
    probeId: input.probeId,
    // 无来源路径使用服务端 FrozenProbeRef 事实（不采信客户端 publicSceneHash）。
    publicSceneContractId: source?.publicSceneContractId ?? frozenProbe.publicSceneContractId,
    publicPayloadHash: source?.publicPayloadHash ?? frozenProbe.publicPayloadHash,
    privateSolutionId: source?.privateSolutionId ?? frozenProbe.privateSolutionId,
    privateSolutionHash: source?.privateSolutionHash ?? frozenProbe.privateSolutionHash,
    sceneSafetyReportHash: source?.sceneSafetyReportHash ?? frozenProbe.sceneSafetyReportHash,
    disclosureProfileHash: source?.disclosureProfileHash ?? frozenProbe.disclosureProfileHash,
    inputSchemaHash: source?.inputSchemaHash ?? "",
    modality: "text_or_mixed",
    contentHash,
    payload: {
      text: input.text,
      contentHash,
      ...(source !== null ? { supersedesArtifactId: source.id } : {}),
    },
    status: "locked",
    revision: source === null ? 0 : source.revision + 1,
    supersedesArtifactId: source?.id ?? null,
    correctionMethod: "manual_text_edit",
    answerLockedAt: now.toISOString(),
    episodeTargetFingerprint: source?.episodeTargetFingerprint ?? episodeSummary?.episodeTargetFingerprint ?? "",
    contentExposureKey: source?.contentExposureKey ?? episodeSummary?.contentExposureKey ?? "",
    requestedTrustClass: TrustClass.MASTERY_ELIGIBLE,
    templateTrustCeiling: source?.templateTrustCeiling ?? frozenProbe.templateTrustCeiling,
    effectiveTrustClass: null,
    trustPolicyVersion: source?.trustPolicyVersion ?? "trust-policy-v1",
    trustReasonCodes: [],
  };

  // 构造后统一逐 hash 校验（覆盖有/无来源两条路径）。
  assertArtifactMatchesFrozenProbe(artifact, frozenProbe);

  const created = await context.repository.createArtifact(artifact);
  if (source !== null) {
    await context.repository.updateArtifact(
      context.workspaceId,
      context.userId,
      source.id,
      source.revision,
      { status: "superseded" },
    );
  }
  return created;
}

// ─── 日志净化（§13.2：音频/transcript/题面/答案不进入普通日志）─────────────

const SENSITIVE_LOG_KEYS = new Set([
  "audio",
  "audioRef",
  "audioHash",
  "transcript",
  "confirmedTranscript",
  "segment",
  "segmentTimestamps",
  "text",
  "answer",
  "answerExcerpt",
  "prompt",
  "claim",
  "payload",
  "rationale",
  "sourceText",
]);

/**
 * 递归净化待落日志/analytics 的对象：移除（置为 [redacted]）敏感字段
 * （音频/transcript/题面/答案/segment/payload）。服务调用方在写日志、
 * Prometheus label 或 analytics payload 前必须经过此函数（01-4 §13.2）。
 */
export function redactForLogs(input: unknown, depth = 0): unknown {
  if (depth > 5) return "[redacted]";
  if (input === null || input === undefined) return input;
  if (typeof input !== "object") return input;
  if (Array.isArray(input)) {
    return input.map((value) => redactForLogs(value, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (SENSITIVE_LOG_KEYS.has(key)) {
      out[key] = "[redacted]";
      continue;
    }
    out[key] = redactForLogs(value, depth + 1);
  }
  return out;
}

// ─── 工具（payload 形状守卫，供上层读取）─────────────────────────────────

/** 判断 artifact payload 是否为未确认 voice draft（无 confirmedAt） */
export function isVoiceDraft(payload: ArtifactPayload): payload is DraftVoicePayload {
  return isDraftVoicePayload(payload);
}

/** 判断 artifact payload 是否为已确认 voice payload（含 confirmedAt） */
export function isConfirmedVoicePayload(
  payload: ArtifactPayload,
): payload is VoicePayload {
  return isDraftVoicePayload(payload) && "confirmedAt" in payload;
}

/** 判断 artifact payload 是否为 text_or_mixed */
export function isTextOrMixed(payload: ArtifactPayload): payload is TextOrMixedPayload {
  return isTextOrMixedPayload(payload);
}
