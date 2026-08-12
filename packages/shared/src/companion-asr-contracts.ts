import { z } from "zod";

/**
 * P6 §13：本地 SenseVoice（sherpa-onnx）utility process ASR 合同。
 *
 * 拓扑：Electron Pet renderer → (typed preload IPC) → main → utilityProcess
 * （Node 侧加载 sherpa-onnx-node + SenseVoice int8 模型）。AudioWorklet 采集
 * PCM（Float32Array）经 IPC 结构化克隆送 utility process 识别。
 *
 * 设计约束（§13 + §11.3）：
 * - renderer 不持有模型路径之外的任何敏感信息；API Key 始终留服务端；
 * - IPC payload 在 main 侧按本文件 schema 校验（sender 校验见 register-asr-ipc）；
 * - Float32Array 不经 JSON 序列化，走 Electron structured clone；schema 仅
 *   校验标量字段与边界。
 */

/** utility process 侧模型配置（路径由 main 从受信配置注入，renderer 不可改）。 */
export const asrModelConfigV1Schema = z.object({
  /** model.int8.onnx 绝对路径 */
  modelPath: z.string().min(1).max(1024),
  /** tokens.txt 绝对路径 */
  tokensPath: z.string().min(1).max(1024),
  /** SenseVoice 识别语言："" = auto（官方默认） */
  language: z.string().max(16).default(""),
  /** useInverseTextNormalization（官方示例 1） */
  useInverseTextNormalization: z.number().int().min(0).max(1).default(1),
}).strict();
export type AsrModelConfigV1 = z.infer<typeof asrModelConfigV1Schema>;

/** 静态兼容 + 性能探测结果（与 companion-asr-router 的 ProbeResult 对齐）。 */
export const asrProbeResultV1Schema = z.object({
  coldStartMs: z.number().int().min(-1),
  warmRtf: z.number().finite().min(-1),
  peakMemoryDeltaMB: z.number().int(),
  modelCrashed: z.boolean(),
  sustainedSlow: z.boolean(),
  modelLoadFailed: z.boolean(),
}).strict();
export type AsrProbeResultV1 = z.infer<typeof asrProbeResultV1Schema>;

/** probe 请求：main → utility process。 */
export const asrProbeRequestV1Schema = z.object({
  version: z.literal(1),
  /** worker 消息分发键（asr-utility-worker switch message.type） */
  type: z.literal("probe"),
  config: asrModelConfigV1Schema,
  /** 内置测试音频（3–5s 16kHz mono PCM，Float32Array；结构化克隆） */
  testAudio: z.custom<Float32Array>((v) => v instanceof Float32Array),
  sampleRate: z.number().int().min(8000).max(48000).default(16000),
  warmRounds: z.number().int().min(1).max(5).default(3),
}).strict();
export type AsrProbeRequestV1 = z.infer<typeof asrProbeRequestV1Schema>;

export const asrProbeResponseV1Schema = z.discriminatedUnion("ok", [
  z.object({ version: z.literal(1), ok: z.literal(true), probe: asrProbeResultV1Schema }).strict(),
  z.object({ version: z.literal(1), ok: z.literal(false), error: z.string().max(512) }).strict(),
]);
export type AsrProbeResponseV1 = z.infer<typeof asrProbeResponseV1Schema>;

/** recognize 请求：renderer → utility process（PCM 16kHz mono Float32Array）。 */
export const asrRecognizeRequestV1Schema = z.object({
  version: z.literal(1),
  pcm: z.custom<Float32Array>((v) => v instanceof Float32Array),
  /** 最长 60s（合同 §11.3 录音上限） */
  sampleRate: z.number().int().min(8000).max(48000).default(16000),
}).strict();
export type AsrRecognizeRequestV1 = z.infer<typeof asrRecognizeRequestV1Schema>;

export const asrRecognizeResponseV1Schema = z.discriminatedUnion("ok", [
  z.object({
    version: z.literal(1),
    ok: z.literal(true),
    text: z.string().max(4000),
    elapsedMs: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    version: z.literal(1),
    ok: z.literal(false),
    error: z.string().max(512),
    recoverable: z.boolean().default(true),
  }).strict(),
]);
export type AsrRecognizeResponseV1 = z.infer<typeof asrRecognizeResponseV1Schema>;

/** main → utility process 的 recognize 消息（含模型 config；worker 需要）。 */
export const asrWorkerRecognizeRequestV1Schema = z.object({
  version: z.literal(1),
  /** worker 消息分发键（asr-utility-worker switch message.type） */
  type: z.literal("recognize"),
  config: asrModelConfigV1Schema,
  pcm: z.custom<Float32Array>((v) => v instanceof Float32Array),
  sampleRate: z.number().int().min(8000).max(48000).default(16000),
}).strict();
export type AsrWorkerRecognizeRequestV1 = z.infer<typeof asrWorkerRecognizeRequestV1Schema>;

/** utility process 生命周期消息（dispose / status）。 */
export const asrDisposeRequestV1Schema = z.object({
  version: z.literal(1),
}).strict();

export const asrStatusResponseV1Schema = z.object({
  version: z.literal(1),
  loaded: z.boolean(),
  modelPath: z.string().max(1024).nullable(),
}).strict();
export type AsrStatusResponseV1 = z.infer<typeof asrStatusResponseV1Schema>;

/** IPC channel 名（renderer preload 与 main 共用）。 */
export const ASR_IPC_CHANNELS = {
  capability: "asr:capability",
  probe: "asr:probe",
  recognize: "asr:recognize",
  ensurePermission: "asr:ensure-permission",
  dispose: "asr:dispose",
  status: "asr:status",
} as const;
export type AsrIpcChannelV1 = (typeof ASR_IPC_CHANNELS)[keyof typeof ASR_IPC_CHANNELS];

/** renderer 侧能力投影（browser fallback 恒不可用）。 */
export const asrRuntimeCapabilityV1Schema = z.discriminatedUnion("available", [
  z.object({
    available: z.literal(true),
    config: asrModelConfigV1Schema,
    // 2026-08-12（P6 真机验证）：本地 ASR 路由门槛需要真实 CPU arch——
    // staticCompatPass 对 arch==="other" 一律拒绝，此前页面侧拿不到 arch
    // 导致本地路由永不启用。main 进程注入 process.arch。
    arch: z.enum(["x64", "arm64"]),
  }).strict(),
  z.object({
    available: z.literal(false),
    reason: z.enum(["no-electron", "no-model", "not-configured", "unsupported-platform"]),
  }).strict(),
]);
export type AsrRuntimeCapabilityV1 = z.infer<typeof asrRuntimeCapabilityV1Schema>;

/** Pet renderer 经 typed preload 暴露的 ASR 窄接口（browser fallback 无）。 */
export interface DesktopAsrApiV1 {
  /** 模型配置是否可用（main 侧 resolveAsrModelConfig） */
  getCapability(): Promise<AsrRuntimeCapabilityV1>;
  /** 性能探测：加载模型 + 跑内置测试音频；失败返回 { ok: false } */
  probe(testAudio: Float32Array): Promise<AsrProbeResponseV1>;
  /** 识别一段 16kHz mono PCM；失败返回 { ok: false, recoverable } */
  recognize(pcm: Float32Array, sampleRate?: number): Promise<AsrRecognizeResponseV1>;
  /** 释放模型与 worker */
  dispose(): Promise<void>;
  /** 2026-08-12：录音前请求 macOS 麦克风权限（主进程 askForMediaAccess） */
  ensurePermission(): Promise<{ granted: boolean; status: string }>;
}

/** renderer → main IPC 载荷（config 由 main 从受信配置解析，renderer 不传）。 */
export const asrIpcProbePayloadV1Schema = z.object({
  version: z.literal(1),
  testAudio: z.custom<Float32Array>((v) => v instanceof Float32Array),
}).strict();

export const asrIpcRecognizePayloadV1Schema = z.object({
  version: z.literal(1),
  pcm: z.custom<Float32Array>((v) => v instanceof Float32Array),
  sampleRate: z.number().int().min(8000).max(48000).optional(),
}).strict();
