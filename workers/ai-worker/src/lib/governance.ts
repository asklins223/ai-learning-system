/**
 * N-011: Worker 端 AI 隐私治理模块。
 *
 * 从 workspace 读取 AI 治理配置，执行：
 * 1. 同意门禁 — 未签署 AI 同意的工作区不能调用外部 AI provider（mock 豁免）
 * 2. sendToExternal 门禁 — sendToExternal=false 时拒绝向外部 provider 发送数据
 * 3. PII 检测 — 发送前检测和脱敏 PII（邮箱、手机号、身份证号等）
 * 4. 审计日志 — 每次 AI 调用写入 ai_audit_log 表，支持隐私追溯
 * 5. Provider 选择 — 个人配置优先，其次 workspace，最后回退到全局环境变量
 */

import { eq } from "drizzle-orm";
import { safeErrorMessage, resolveSystemPlatform, resolveLegacyProviderConfig } from "@ailearn/shared";
import type { AITaskType } from "@ailearn/shared";
import { getCapabilityForTask, getTaskComplexity } from "@ailearn/shared";
import { db } from "../db.ts";
import * as schema from "../schema/index.ts";
import { logger } from "./logger.ts";

/**
 * Stable, privacy-safe governance error used by the job projection layer.
 *
 * The queue sanitiser persists `code` but deliberately removes free-form
 * messages. Keeping the consent reason as a machine-readable code lets the
 * web app offer the correct recovery action without exposing provider or
 * user content in `jobs.last_error`.
 */
export class AIConsentRequiredError extends Error {
  readonly code = "ai_consent_required";

  constructor() {
    super("AI consent not signed for this workspace");
    this.name = "AIConsentRequiredError";
  }
}

export interface WorkspaceAIPolicy {
  sendToExternal: boolean;
  sendImageContent?: boolean;
  piiDetection: boolean;
  auditLogging: boolean;
}

export const DEFAULT_AI_DATA_POLICY: WorkspaceAIPolicy = {
  sendToExternal: false,
  sendImageContent: false,
  piiDetection: true,
  auditLogging: true,
};

/**
 * QUAL-28: Factory function that returns a fresh copy of the default AI
 * data policy. Use this instead of `{ ...DEFAULT_AI_DATA_POLICY }` to
 * centralise the creation logic and avoid accidental shared references.
 */
export function createDefaultAIPolicy(): WorkspaceAIPolicy {
  return { ...DEFAULT_AI_DATA_POLICY };
}

export function normalizeWorkspaceAIPolicy(value: unknown): WorkspaceAIPolicy {
  if (!value || typeof value !== "object") return createDefaultAIPolicy();
  const policy = value as Partial<WorkspaceAIPolicy>;
  // QUAL-28: 直接从 DEFAULT_AI_DATA_POLICY 读取字段默认值是安全的，
  // 因为只是读操作而非创建引用副本。仅在需要返回完整新对象时使用 createDefaultAIPolicy()。
  return {
    sendToExternal: typeof policy.sendToExternal === "boolean"
      ? policy.sendToExternal
      : DEFAULT_AI_DATA_POLICY.sendToExternal,
    sendImageContent: typeof policy.sendImageContent === "boolean"
      ? policy.sendImageContent
      : DEFAULT_AI_DATA_POLICY.sendImageContent,
    piiDetection: typeof policy.piiDetection === "boolean"
      ? policy.piiDetection
      : DEFAULT_AI_DATA_POLICY.piiDetection,
    auditLogging: typeof policy.auditLogging === "boolean"
      ? policy.auditLogging
      : DEFAULT_AI_DATA_POLICY.auditLogging,
  };
}

/**
 * N-011: 检查工作区是否已签署 AI 同意。
 * mock provider 豁免 — 不需要同意即可使用。
 * 其他 provider 需要已签署同意（aiConsentVersion 非空且 aiConsentAt 非空）。
 *
 * @deprecated 使用 resolveAIGovernanceContext 替代。该函数会独立查询 workspaces 表，
 * 与 resolveAIGovernanceContext 中的 workspace 查询重复。调用方应先调用
 * resolveAIGovernanceContext 获取 consentOk 字段，避免冗余 DB 查询。
 */
export async function checkAIConsent(workspaceId: string, providerName: string): Promise<boolean> {
  // mock provider 不需要 AI 同意，始终放行
  if (providerName.toLowerCase() === "mock") return true;
  const ws = await db.query.workspaces.findFirst({
    where: eq(schema.workspaces.id, workspaceId),
  });
  if (!ws) return false;
  // 其他 provider 需要已签署同意
  return ws.aiConsentVersion !== null && ws.aiConsentAt !== null;
}

/**
 * 一次性解析 AI 调用所需的全部治理上下文：provider 选择 + consent + policy。
 * 这消除了 checkAIConsent + enforcePrivacyGovernance + resolveProviderSelection
 * 中对 workspaces 表的重复查询（原先最多查 3 次，现在只查 1 次）。
 *
 * v0.6 单一配置源重构：平台解析完全收敛到 config/ai-platforms.json，
 * 不再查 personal BYOK 或 workspace.aiProvider。每个 capability 直接从
 * resolveSystemPlatform(cap) 解析。
 */
export interface AIGovernanceContext {
  providerName: string;
  providerConfig: import("./ai-provider.ts").AIProviderRuntimeConfig;
  /** 独立的文本生成（轻量任务）provider 配置。
   * 当系统配置中 text_generation 映射到不同于 agent_turn 的平台时,
   * 此字段持有该平台配置,用于 evaluate_validation / generate_question /
   * evaluate_rubric 等低复杂度任务,以便使用更便宜的模型。
   * 当未单独配置时为 null,回退到 providerName/providerConfig。 */
  textProviderName: string | null;
  textProviderConfig: import("./ai-provider.ts").AIProviderRuntimeConfig | null;
  /** 独立的视觉模型配置。当系统配置了独立的 vision 平台时,
   * 此字段与 providerConfig 不同（不同平台/Key/模型）。
   * 当未配置 vision 时,回退到 providerConfig。 */
  visionProviderName: string | null;
  visionProviderConfig: import("./ai-provider.ts").AIProviderRuntimeConfig | null;
  /** 独立的向量嵌入 provider 配置（plan §3.4: embedding 折进治理 map）。
   * 当系统配置了独立 embedding 平台时,
   * 此字段持有该平台配置。
   * 当未配置时为 null,调用方应回退到主 provider 的 embed() 方法。 */
  embeddingProviderName: string | null;
  embeddingProviderConfig: import("./ai-provider.ts").AIProviderRuntimeConfig | null;
  consentOk: boolean;
  policy: WorkspaceAIPolicy;
}

/**
 * R3: Resolve which provider to use for a given AI task.
 *
 * Uses the task → capability mapping from task-router.ts to determine
 * which provider slot to read from the governance context.
 *
 * Resolution priority within the governance context:
 *   1. If the task requires "vision", use visionProviderName/visionProviderConfig
 *      (falls back to text provider if no separate vision config).
 *   2. If the task requires "text_generation", use textProviderName/
 *      textProviderConfig if set (enables cheaper models for lightweight tasks
 *      like validation/rubric/question generation). Falls back to main provider.
 *   3. If the task requires "agent_turn", use the main providerName/providerConfig.
 *   4. If the task requires "embedding", the governance context does not hold
 *      an embedding slot — callers should use createEmbeddingProvider() directly.
 *      This function returns the text provider as a fallback.
 *   5. For unknown capabilities, fall back based on task complexity:
 *      high → agent_turn provider, low → text_generation provider.
 *
 * @see docs/plans/provider-registry-refactor.md §3.4
 */
export function resolveProviderForTask(
  ctx: AIGovernanceContext,
  task: AITaskType,
): { providerName: string; providerConfig: import("./ai-provider.ts").AIProviderRuntimeConfig } {
  const cap = getCapabilityForTask(task);

  // Vision tasks use the vision provider slot
  if (cap === "vision") {
    if (ctx.visionProviderName && ctx.visionProviderConfig) {
      return { providerName: ctx.visionProviderName, providerConfig: ctx.visionProviderConfig };
    }
    // Fall back to text provider for vision
    return { providerName: ctx.providerName, providerConfig: ctx.providerConfig };
  }

  // Text generation: use dedicated text provider if configured (enables
  // routing lightweight tasks to a cheaper model). Falls back to main provider.
  if (cap === "text_generation") {
    if (ctx.textProviderName && ctx.textProviderConfig) {
      return { providerName: ctx.textProviderName, providerConfig: ctx.textProviderConfig };
    }
    return { providerName: ctx.providerName, providerConfig: ctx.providerConfig };
  }

  // Agent turn uses the main text provider slot
  if (cap === "agent_turn") {
    return { providerName: ctx.providerName, providerConfig: ctx.providerConfig };
  }

  // Embedding: use dedicated embedding provider if configured (plan §3.4).
  // Falls back to the text provider (whose embed() method may still work).
  if (cap === "embedding" || cap === "rerank") {
    if (ctx.embeddingProviderName && ctx.embeddingProviderConfig) {
      return { providerName: ctx.embeddingProviderName, providerConfig: ctx.embeddingProviderConfig };
    }
    return { providerName: ctx.providerName, providerConfig: ctx.providerConfig };
  }

  // Future capabilities: fall back based on task complexity
  const complexity = getTaskComplexity(task);
  if (complexity === "high") {
    return { providerName: ctx.providerName, providerConfig: ctx.providerConfig };
  }
  return { providerName: ctx.providerName, providerConfig: ctx.providerConfig };
}

/**
 * 为指定 provider 名称解析连接配置（config/ai-platforms.json 类型匹配 → legacy env 回退）。
 *
 * 供 agent run/prepare 阶段的 providerSnapshot 对账使用：
 * 当冻结的 snapshot 名与当前治理上下文 provider 不一致时，按 snapshot 名重新解析配置，
 * 避免用治理上下文中另一个 provider 的 config 配 snapshot 名（跨 provider 混配）。
 *
 * v0.6 单一配置源重构：workspace pin 分支已删除，仅保留系统平台 + legacy env 回退。
 */
export function resolveProviderConfigForName(providerName: string): import("./ai-provider.ts").AIProviderRuntimeConfig {
  const platform = resolveSystemPlatform("agent_turn");
  if (platform && platform.type.toLowerCase() === providerName.toLowerCase()) {
    return {
      apiKey: platform.apiKey,
      baseUrl: platform.baseUrl,
      model: platform.model,
      visionModel: platform.visionModel,
      options: platform.options,
    };
  }
  return resolveLegacyProviderConfig(providerName) ?? {};
}

export async function resolveAIGovernanceContext(
  workspaceId: string,
  userId: string | null,
): Promise<AIGovernanceContext> {
  // v0.6 单一配置源重构：不再查 personal BYOK，平台解析完全收敛到
  // config/ai-platforms.json。仍查 workspaces 获取 policy/consent。
  void userId; // userId no longer used for BYOK lookup
  const ws = await db.query.workspaces.findFirst({
    where: eq(schema.workspaces.id, workspaceId),
  });

  // agent_turn — 主文本/agent provider
  let providerName: string;
  let providerConfig: import("./ai-provider.ts").AIProviderRuntimeConfig = {};
  const agentPlatform = resolveSystemPlatform("agent_turn");
  if (agentPlatform) {
    providerName = agentPlatform.type;
    providerConfig = {
      apiKey: agentPlatform.apiKey,
      baseUrl: agentPlatform.baseUrl,
      model: agentPlatform.model,
      visionModel: agentPlatform.visionModel,
      options: agentPlatform.options,
    };
  } else {
    providerName = (process.env.AI_PROVIDER_CARD ?? "mock").toLowerCase();
    // §2.3 mock 静默回退告警：系统平台未配置（apiKey 缺失/含未解析 ${VAR}）。
    // 若不告警，生产链路会照常运行但产出固定假文本，用户与日志无法区分。
    logger.warn(
      {
        workspaceId,
        capability: "agent_turn",
        fallback: providerName,
      },
      "agent_turn 平台未配置，回退到默认 provider（mock 输出为固定假文本）",
    );
  }

  // vision — 独立系统级视觉平台（未配置时回退到主 provider）
  let visionProviderName: string | null = null;
  let visionProviderConfig: import("./ai-provider.ts").AIProviderRuntimeConfig | null = null;
  const visionPlatform = resolveSystemPlatform("vision");
  if (visionPlatform) {
    visionProviderName = visionPlatform.type;
    visionProviderConfig = {
      apiKey: visionPlatform.apiKey,
      baseUrl: visionPlatform.baseUrl,
      model: visionPlatform.model,
      visionModel: visionPlatform.visionModel,
      options: visionPlatform.options,
    };
  }

  // text_generation — 独立系统级轻量文本平台（未配置时回退到主 provider）
  let textProviderName: string | null = null;
  let textProviderConfig: import("./ai-provider.ts").AIProviderRuntimeConfig | null = null;
  const textPlatform = resolveSystemPlatform("text_generation");
  if (textPlatform) {
    textProviderName = textPlatform.type;
    textProviderConfig = {
      apiKey: textPlatform.apiKey,
      baseUrl: textPlatform.baseUrl,
      model: textPlatform.model,
      options: textPlatform.options,
    };
  }

  // embedding — 独立系统级嵌入平台（未配置时回退到主 provider）
  let embeddingProviderName: string | null = null;
  let embeddingProviderConfig: import("./ai-provider.ts").AIProviderRuntimeConfig | null = null;
  const embeddingPlatform = resolveSystemPlatform("embedding");
  if (embeddingPlatform) {
    embeddingProviderName = embeddingPlatform.type;
    embeddingProviderConfig = {
      apiKey: embeddingPlatform.apiKey,
      baseUrl: embeddingPlatform.baseUrl,
      model: embeddingPlatform.model,
      options: embeddingPlatform.options,
    };
  }

  let policy: WorkspaceAIPolicy = createDefaultAIPolicy();
  let consentOk = true;

  // Check consent for any non-mock external provider (agent / vision / text_gen / embedding).
  const anyExternalNonMock =
    providerName.toLowerCase() !== "mock" ||
    (visionProviderName != null && visionProviderName.toLowerCase() !== "mock") ||
    (textProviderName != null && textProviderName.toLowerCase() !== "mock") ||
    (embeddingProviderName != null && embeddingProviderName.toLowerCase() !== "mock");

  if (ws) {
    policy = normalizeWorkspaceAIPolicy(ws.aiDataPolicy);
    // consent 检查（mock 豁免）
    if (anyExternalNonMock) {
      consentOk = ws.aiConsentVersion !== null && ws.aiConsentAt !== null;
    }
  } else if (anyExternalNonMock) {
    // Fail-closed: workspace not found, deny non-mock providers
    consentOk = false;
  }

  return { providerName, providerConfig, textProviderName, textProviderConfig, visionProviderName, visionProviderConfig, embeddingProviderName, embeddingProviderConfig, consentOk, policy };
}



/**
 * N-011: 获取工作区 AI 数据策略。
 */
export async function getWorkspaceAIPolicy(workspaceId: string): Promise<WorkspaceAIPolicy> {
  const ws = await db.query.workspaces.findFirst({
    where: eq(schema.workspaces.id, workspaceId),
  });
  if (!ws) {
    return createDefaultAIPolicy();
  }
  return normalizeWorkspaceAIPolicy(ws.aiDataPolicy);
}

/**
 * N-011: 写入 AI 调用审计日志。
 */
/**
 * N-011: PII 检测和脱敏。
 * 检测文本中的常见 PII 模式（邮箱、手机号、身份证号、银行卡号）并脱敏。
 */
/**
 * Luhn checksum validation for bank card numbers.
 * Returns true if the digit string passes the Luhn algorithm.
 */
function luhnCheck(num: string): boolean {
  let sum = 0;
  let isEven = false;
  for (let i = num.length - 1; i >= 0; i--) {
    let digit = parseInt(num[i], 10);
    if (isNaN(digit)) return false;
    if (isEven) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    isEven = !isEven;
  }
  return sum % 10 === 0;
}

/**
 * PII 正则模式定义。
 *
 * PERF-12 修复：所有正则在模块加载时一次性预编译为 `compiled` 字段，
 * 之后 detectAndSanitizePII 的每次调用都复用同一实例，不再每次创建新 RegExp。
 *
 * 复用安全性说明：String.prototype.match() 和 String.prototype.replace()
 * 内部会重置 g 标志 RegExp 的 lastIndex，因此单个预编译实例在多次调用间
 * 不会出现 lastIndex 状态泄漏问题（仅在 test()/exec() 场景才有此风险）。
 *
 * 保留 source 和 flags 字段是为了调试和未来动态重建正则的需求。
 *
 * QUAL-12: 修复 [A-Z|a-z] → [A-Za-z]（`|` 曾被误写为字面管道符）。
 * QUAL-13: 银行卡模式新增 Luhn 校验，避免对任意长数字（时间戳、订单号等）误匹配。
 */
interface PIIPatternDef {
  source: string;
  flags: string;
  label: string;
  /** Optional post-match validation (e.g. Luhn check for bank cards). */
  validate?: (match: string) => boolean;
  /** PERF-12 修复：预编译的 RegExp 实例，避免每次调用重新创建 */
  compiled: RegExp;
}

const PII_PATTERN_DEFS: PIIPatternDef[] = [
  { source: "\\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}\\b", flags: "g", label: "email", compiled: /(?:)/g },
  { source: "\\b1[3-9]\\d{9}\\b", flags: "g", label: "phone", compiled: /(?:)/g },
  { source: "\\b\\d{6}(18|19|20)\\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\\d|3[01])\\d{3}[\\dXx]\\b", flags: "g", label: "id_card", compiled: /(?:)/g },
  { source: "\\b\\d{16,19}\\b", flags: "g", label: "bank_card", validate: luhnCheck, compiled: /(?:)/g },
  // SEC-01: Additional PII patterns
  // SEC-10 修复：IPv4 地址正则需要排除版本号误匹配。
  // 原正则 \b...\b 会匹配 "1.2.3.4" 这样的版本号字符串。
  // 修复策略：使用 negative lookbehind/lookahead 排除前后还有数字或点的上下文。
  // 注意：JS 正则不支持固定宽度 lookbehind 在所有引擎中，但 V8 支持。
  // (?<!\d\.)(?<!\d) 确保前面不是数字或"数字."，(?!\.?\d) 确保后面不是。
  { source: "(?<!\\d\\.)(?<!\\d)\\b(?:(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)\\.){3}(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)\\b(?!\\.?\\d)", flags: "g", label: "ip_address", compiled: /(?:)/g },
];
// PERF-12 修复：模块加载时一次性编译所有正则表达式
for (const def of PII_PATTERN_DEFS) {
  def.compiled = new RegExp(def.source, def.flags);
}

interface PIIDetectionResult {
  hasPII: boolean;
  detectedTypes: string[];
  sanitizedText: string;
}

export function detectAndSanitizePII(text: string): PIIDetectionResult {
  const detectedTypes = new Set<string>();
  let sanitizedText = text;

  for (const def of PII_PATTERN_DEFS) {
    // PERF-12 修复：使用模块加载时预编译的 RegExp，不再每次创建新实例。
    // 注意：String.match() 和 String.replace() 不会修改 g 标志 RegExp 的 lastIndex，
    // 因此单个实例在多次调用间是安全的。
    const pattern = def.compiled;
    const matches = text.match(pattern);
    if (!matches || matches.length === 0) continue;

    // QUAL-13: If a validation function is defined, only count matches that pass.
    const validMatches = def.validate
      ? matches.filter(def.validate)
      : matches;
    if (validMatches.length === 0) continue;

    detectedTypes.add(def.label);
    // 脱敏：保留首尾字符，中间用 *** 替代
    // QUAL-24: Reuse the same pattern — replace() resets lastIndex internally.
    sanitizedText = sanitizedText.replace(pattern, (match) => {
      if (def.validate && !def.validate(match)) return match;
      if (match.length <= 4) return "***";
      return match[0] + "***" + match[match.length - 1];
    });
  }

  return {
    hasPII: detectedTypes.size > 0,
    detectedTypes: Array.from(detectedTypes),
    sanitizedText,
  };
}

/**
 * N-011: 对对象中的所有字符串值进行 PII 脱敏。
 * 递归遍历对象，对所有字符串字段进行 PII 检测和脱敏。
 */
export function sanitizePIIInObject<T>(obj: T): { data: T; detectedTypes: string[] } {
  const allDetectedTypes = new Set<string>();

  function sanitizeValue(value: unknown): unknown {
    if (typeof value === "string") {
      const result = detectAndSanitizePII(value);
      for (const t of result.detectedTypes) allDetectedTypes.add(t);
      return result.sanitizedText;
    }
    if (Array.isArray(value)) {
      return value.map(sanitizeValue);
    }
    if (value !== null && typeof value === "object") {
      // QUAL-07 fix: Preserve Date instances and other non-plain objects.
      // Previously, all objects were converted to plain objects via
      // Object.entries(), losing prototype chain and type information.
      if (value instanceof Date) {
        return new Date(value.getTime());
      }
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        result[k] = sanitizeValue(v);
      }
      return result;
    }
    return value;
  }

  return { data: sanitizeValue(obj) as T, detectedTypes: Array.from(allDetectedTypes) };
}

/**
 * N-011: 执行完整的隐私治理检查。
 * 返回通过/拒绝结果，以及脱敏后的数据（如果需要脱敏）。
 *
 * BUG-60 修复：标记为 @deprecated。此函数内部会独立查询 workspaces 表
 * 获取 AI policy，产生冗余 DB 查询。调用方应先调用 resolveAIGovernanceContext
 * 获取 policy，再使用 enforcePrivacyGovernanceWithPolicy 执行检查，
 * 避免重复查询。
 *
 * @deprecated 使用 enforcePrivacyGovernanceWithPolicy 替代，配合 resolveAIGovernanceContext。
 */
/** @deprecated 使用 enforcePrivacyGovernanceWithPolicy 替代 */
export async function enforcePrivacyGovernance(
  workspaceId: string,
  dataCategories: string[],
  data: Record<string, unknown>,
  providerName: string,
): Promise<{
  allowed: boolean;
  reason?: string;
  sanitizedData: Record<string, unknown>;
  piiDetectedTypes: string[];
}> {
  const policy = await getWorkspaceAIPolicy(workspaceId);
  return enforcePrivacyGovernanceWithPolicy(policy, workspaceId, dataCategories, data, providerName);
}

/**
 * 使用预解析的 policy 执行隐私治理检查，避免重复查询 workspaces 表。
 * 与 resolveAIGovernanceContext 配合使用。
 */
export function enforcePrivacyGovernanceWithPolicy(
  policy: WorkspaceAIPolicy,
  workspaceId: string,
  dataCategories: string[],
  data: Record<string, unknown>,
  providerName: string,
): {
  allowed: boolean;
  reason?: string;
  sanitizedData: Record<string, unknown>;
  piiDetectedTypes: string[];
} {
  const provider = providerName.toLowerCase();

  // 1. sendToExternal 门禁：非 mock provider + sendToExternal=false → 拒绝
  if (provider !== "mock" && !policy.sendToExternal) {
    return {
      allowed: false,
      reason: "Workspace policy forbids sending data to external AI providers (sendToExternal=false). Owner must enable this in workspace settings.",
      sanitizedData: data,
      piiDetectedTypes: [],
    };
  }

  if (provider !== "mock" && dataCategories.includes("image_content") && !policy.sendImageContent) {
    return {
      allowed: false,
      reason: "Workspace policy has not authorized sending image content to external AI providers (sendImageContent=false).",
      sanitizedData: data,
      piiDetectedTypes: [],
    };
  }

  // 2. PII 检测和脱敏
  let sanitizedData = data;
  let piiDetectedTypes: string[] = [];
  if (policy.piiDetection && provider !== "mock") {
    const result = sanitizePIIInObject(data);
    sanitizedData = result.data;
    piiDetectedTypes = result.detectedTypes;
    if (piiDetectedTypes.length > 0) {
      logger.info(
        { workspaceId, detectedTypes: piiDetectedTypes, categories: dataCategories },
        "PII detected and sanitized before sending to external AI provider",
      );
    }
  }

  return { allowed: true, sanitizedData, piiDetectedTypes };
}

export interface AICallAuditParams {
  workspaceId: string;
  userId: string;
  jobId?: string | null;
  provider: string;
  modelId: string;
  operation: string;
  dataCategories?: string[];
  dataSizeBytes?: number | null;
  costTokens?: number | null;
  durationMs?: number | null;
  status?: string;
  errorMessage?: string | null;
}

interface AuditLogDependencies {
  getPolicy?: (workspaceId: string) => Promise<WorkspaceAIPolicy>;
  write?: (values: typeof schema.aiAuditLog.$inferInsert) => Promise<void>;
}

export async function logAICall(
  params: AICallAuditParams,
  dependencies: AuditLogDependencies = {},
): Promise<boolean> {
  try {
    const getPolicy = dependencies.getPolicy ?? getWorkspaceAIPolicy;
    const policy = await getPolicy(params.workspaceId);
    if (!policy.auditLogging) {
      logger.debug(
        { workspaceId: params.workspaceId, operation: params.operation },
        "AI audit logging disabled by workspace policy",
      );
      return false;
    }

    const values: typeof schema.aiAuditLog.$inferInsert = {
      workspaceId: params.workspaceId,
      userId: params.userId,
      jobId: params.jobId ?? null,
      provider: params.provider,
      modelId: params.modelId,
      operation: params.operation,
      dataCategories: params.dataCategories ?? [],
      dataSizeBytes: params.dataSizeBytes ?? null,
      costTokens: params.costTokens ?? null,
      durationMs: params.durationMs ?? null,
      status: params.status ?? "success",
      errorMessage: params.errorMessage ? safeErrorMessage(params.errorMessage) : null,
    };
    const write = dependencies.write ?? (async (row) => {
      await db.insert(schema.aiAuditLog).values(row);
    });
    await write(values);
    return true;
  } catch (err) {
    // 审计日志写入失败不应阻塞主流程
    logger.error({ err, operation: params.operation }, "failed to write AI audit log");
    return false;
  }
}
