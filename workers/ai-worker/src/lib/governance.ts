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
import { decryptAiCredential } from "@ailearn/shared/ai-credentials";
import { safeErrorMessage } from "@ailearn/shared";
import { db } from "../db.ts";
import * as schema from "../schema/index.ts";
import { logger } from "./logger.ts";

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

export function normalizeWorkspaceAIPolicy(value: unknown): WorkspaceAIPolicy {
  if (!value || typeof value !== "object") return { ...DEFAULT_AI_DATA_POLICY };
  const policy = value as Partial<WorkspaceAIPolicy>;
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
 */
export interface AIGovernanceContext {
  providerName: string;
  providerConfig: import("./ai-provider.ts").AIProviderRuntimeConfig;
  consentOk: boolean;
  policy: WorkspaceAIPolicy;
}

export async function resolveAIGovernanceContext(
  workspaceId: string,
  userId: string | null,
): Promise<AIGovernanceContext> {
  // 并行查询个人配置和 workspaces，消除一次串行 DB 往返。
  const [personalConfig, ws] = await Promise.all([
    userId ? getPersonalAIProviderRuntimeConfig(userId) : Promise.resolve(null),
    db.query.workspaces.findFirst({
      where: eq(schema.workspaces.id, workspaceId),
    }),
  ]);

  let providerName: string;
  let providerConfig: import("./ai-provider.ts").AIProviderRuntimeConfig = {};

  if (personalConfig) {
    providerName = personalConfig.provider;
    providerConfig = personalConfig;
  } else if (ws?.aiProvider) {
    providerName = ws.aiProvider.toLowerCase();
  } else {
    providerName = (process.env.AI_PROVIDER_CARD ?? "mock").toLowerCase();
  }

  let policy: WorkspaceAIPolicy = { ...DEFAULT_AI_DATA_POLICY };
  let consentOk = true;

  if (ws) {
    policy = normalizeWorkspaceAIPolicy(ws.aiDataPolicy);
    // consent 检查（mock 豁免）
    if (providerName.toLowerCase() !== "mock") {
      consentOk = ws.aiConsentVersion !== null && ws.aiConsentAt !== null;
    }
  }

  return { providerName, providerConfig, consentOk, policy };
}

/**
 * 获取 workspace 级 AI provider 名称，缺省时回退到全局配置。
 * 个人配置由 resolveProviderSelection 单独解析，避免重复查询。
 */
export async function getWorkspaceAIProvider(workspaceId: string): Promise<string> {
  const ws = await db.query.workspaces.findFirst({
    where: eq(schema.workspaces.id, workspaceId),
  });
  if (ws?.aiProvider) {
    return ws.aiProvider.toLowerCase();
  }
  // 回退到全局环境变量
  return (process.env.AI_PROVIDER_CARD ?? "mock").toLowerCase();
}

export interface PersonalAIProviderRuntimeConfig {
  provider: string;
  baseUrl: string | null;
  model: string | null;
  apiKey: string | null;
}

/** Resolve and decrypt only the initiating user's row; plaintext never leaves Worker memory. */
export async function getPersonalAIProviderRuntimeConfig(
  userId: string,
): Promise<PersonalAIProviderRuntimeConfig | null> {
  const row = await db.query.userAIModelConfigs.findFirst({
    where: eq(schema.userAIModelConfigs.userId, userId),
  });
  if (!row) return null;
  // `mock` was historically stored as a personal row. It now means “use the
  // workspace/system default”, so legacy rows must not override that default.
  if (row.provider === "mock") {
    return null;
  }
  if (!row.baseUrl || !row.model || !row.apiKeyEncrypted) {
    throw new Error("personal AI model configuration is incomplete");
  }
  return {
    provider: row.provider,
    baseUrl: row.baseUrl,
    model: row.model,
    apiKey: decryptAiCredential(row.apiKeyEncrypted, userId),
  };
}

/**
 * N-011: 获取工作区 AI 数据策略。
 */
export async function getWorkspaceAIPolicy(workspaceId: string): Promise<WorkspaceAIPolicy> {
  const ws = await db.query.workspaces.findFirst({
    where: eq(schema.workspaces.id, workspaceId),
  });
  if (!ws) {
    return { ...DEFAULT_AI_DATA_POLICY };
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
const PII_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, label: "email" },
  { pattern: /\b1[3-9]\d{9}\b/g, label: "phone" },
  { pattern: /\b\d{6}(18|19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/g, label: "id_card" },
  { pattern: /\b\d{16,19}\b/g, label: "bank_card" },
];

interface PIIDetectionResult {
  hasPII: boolean;
  detectedTypes: string[];
  sanitizedText: string;
}

export function detectAndSanitizePII(text: string): PIIDetectionResult {
  const detectedTypes = new Set<string>();
  let sanitizedText = text;

  for (const { pattern, label } of PII_PATTERNS) {
    const matches = text.match(pattern);
    if (matches && matches.length > 0) {
      detectedTypes.add(label);
      // 脱敏：保留首尾字符，中间用 *** 替代
      sanitizedText = sanitizedText.replace(pattern, (match) => {
        if (match.length <= 4) return "***";
        return match[0] + "***" + match[match.length - 1];
      });
    }
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
 */
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
