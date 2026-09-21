/**
 * R2: Provider 能力接口拆分。
 *
 * 将胖 `AIProvider` 接口拆分为按能力维度的独立接口。
 * 新增能力（语音识别、文生图）只需定义新接口 + 注册 + 添加 task 映射，
 * 不需要修改任何现有 provider 代码。
 *
 * @see docs/plans/provider-registry-refactor.md §3.1
 */

import type {
  ProviderUsage,
  AgentTurnRequest,
  AgentTurnResult,
} from "./card-agent-contracts.ts";
import type { ImageInsightOutput } from "./schemas.ts";

// ─── 能力枚举 ──────────────────────────────────────────────────────────

/** 能力枚举 — 可扩展 */
export type Capability =
  | "text_generation"       // 文本生成（chat completion + JSON output）
  | "vision"                // 视觉理解（图片分析、OCR）
  | "agent_turn"            // Agent 工具调用（native tool calls）
  /**
   * 伴星对话的**跨模型兜底**槽（方案 29 §9.6 / B8）。
   *
   * 为什么单独一个槽而不是复用 `text_generation`：`agent_turn` 主模型
   * （qwen3.8-flash）会高频返回退化补全（实测近 3 小时 32 条回复里 21 条不足
   * 6 字，且 `finishReason=stop`、无 maxTokens 截断日志）。同档思考重试救不回
   * 连续两次的退化，必须换一个**模型甚至换一家 provider**。
   * 复用 `text_generation` 会让这个兜底跟着摘要器一起被调走，两者耦合且没人
   * 会想到它们共享一个降级路径。
   */
  | "companion_fallback"    // 伴星退化时的备用对话模型
  | "embedding"             // 向量嵌入
  | "rerank"                // 重排序
  // ── 未来扩展 ──
  | "speech_recognition"    // 语音识别
  | "image_generation";     // 文生图

// ─── 共享类型定义 ──────────────────────────────────────────────────────

/** Chat 消息格式（OpenAI 兼容） */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | Array<
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string; detail?: "auto" | "low" | "high" } }
  >;
}

/** Chat 调用选项 */
export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  model?: string;
  responseFormat?: "json_object" | "text";
  /** 2026-08-12+（15a 新反馈）：显式关闭 provider 思考模式（如 DeepSeek
   *  系模型的 enable_thinking）。优先级高于平台配置/env——companion 日常
   *  对话用它换取首 token 速度（陪伴聊天快比准重要）。 */
  disableThinking?: boolean;
  /**
   * native tools 定义（2026-09-19 ④-b）。
   *
   * 只有流式 chat completion 需要它：带工具的一步也必须能把工具列表发给模型，
   * 否则模型永远不会返回 tool_calls（与 executeAgentTurn 的 `tools` + `tool_choice`
   * 同源，形状取自 AgentTurnRequest.tools）。
   */
  tools?: AgentTurnRequest["tools"];
}

/** Chat 调用结果 */
export interface ChatResult {
  content: string;
  usage: ProviderUsage;
}

/** 重排序结果 */
export interface RerankResult {
  index: number;
  relevanceScore: number;
}

/** 语音转写结果（未来） */
export interface TranscriptionResult {
  text: string;
  language?: string;
  durationMs?: number;
}

/** 文生图结果（未来） */
export interface GeneratedImage {
  base64: string;
  mimeType: string;
}

// ─── 输入类型（从 worker 迁移到 shared，供能力接口引用） ──────────────

/** 图片分析输入 — 从 workers/ai-worker/src/lib/ai-provider.ts 迁移 */
export interface AnalyzeImageInput {
  body: Buffer;
  mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  width: number;
  height: number;
  sha256: string;
  userDescription?: string;
}

// ─── 能力接口 ──────────────────────────────────────────────────────────

/** 文本生成能力 */
export interface TextGenerationCapability {
  readonly modelId: string;
  chatCompletion(
    messages: ChatMessage[],
    options: ChatOptions,
    signal?: AbortSignal,
  ): Promise<ChatResult>;
}

/** 视觉理解能力 */
export interface VisionCapability {
  readonly visionModelId: string;
  analyzeImage(
    input: AnalyzeImageInput,
    signal?: AbortSignal,
  ): Promise<ImageInsightOutput>;
}

/** Agent 工具调用能力 */
export interface AgentTurnCapability {
  executeAgentTurn(
    request: AgentTurnRequest,
    signal?: AbortSignal,
  ): Promise<AgentTurnResult>;
}

/** 向量嵌入能力 */
export interface EmbeddingCapability {
  readonly embeddingModelId: string;
  embed(text: string, signal?: AbortSignal): Promise<number[] | null>;
}

/** 重排序能力 */
export interface RerankCapability {
  rerank(
    params: { query: string; documents: string[]; topN?: number },
    signal?: AbortSignal,
  ): Promise<RerankResult[]>;
}

// ── 未来扩展示例 ──

/** 语音识别能力（未来） */
export interface SpeechRecognitionCapability {
  transcribe(
    input: { audio: Buffer; mimeType: string; language?: string },
    signal?: AbortSignal,
  ): Promise<TranscriptionResult>;
}

/** 文生图能力（未来） */
export interface ImageGenerationCapability {
  generateImage(
    input: { prompt: string; size?: string; n?: number },
    signal?: AbortSignal,
  ): Promise<GeneratedImage[]>;
}

/**
 * 能力实现联合类型。
 * createCapabilityProvider() 返回此类型，调用方按需 narrow 到具体能力接口。
 */
export type CapabilityImpl =
  | TextGenerationCapability
  | VisionCapability
  | AgentTurnCapability
  | EmbeddingCapability
  | RerankCapability;
