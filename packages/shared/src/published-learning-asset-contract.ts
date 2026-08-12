/**
 * PublishedLearningAssetContractV1（冻结契约，决策记录 00-3 §5/§6）
 *
 * Generation → Learning 的消费边界：
 * - required 是 Card（cardId/cardRevision）、Key Point（keyPointId）、claim、
 *   exact evidence（exactEvidenceRefs）、semantic support（semanticSupportReportId/Hash）、
 *   source fingerprint（sourceFingerprint）和 active/superseded 生命周期（lifecycle）。
 * - cognitiveType 与 interactionAffordances 只是 optional hint，不是 required。
 * - Candidate Ledger、relation hints、private draft 和未 Publish 产物一律 forbidden
 *   （schema 使用 strict + 显式负向校验）。
 *
 * contract hash（集成 Gate 第一项）：对契约做稳定化（键排序）JSON 序列化后取 SHA-256。
 * 同一语义对象无论键序如何，hash 恒等；任何 required/内容变化必然改变 hash。
 */

import { createHash } from "node:crypto";
import { z } from "zod";

// ─── 常量 ────────────────────────────────────────────────────────────────

/** 契约版本字面量（冻结，00-3 §5） */
export const PUBLISHED_LEARNING_ASSET_CONTRACT_VERSION =
  "published-learning-asset-v1" as const;

/** 生命周期 enum（00-3 §6.1） */
export const PUBLISHED_LEARNING_ASSET_LIFECYCLES = ["active", "superseded"] as const;
export type PublishedLearningAssetLifecycle =
  (typeof PUBLISHED_LEARNING_ASSET_LIFECYCLES)[number];

/**
 * forbidden 字段清单（00-3 §6.3）：Candidate Ledger、relation hints、private draft、
 * 未 Publish 产物一律 forbidden。schema strict 已拒绝任何未知 key，此处额外提供
 * 显式清单，使集成 Gate 的 forbidden-field 负向测试可精确断言。
 */
export const FORBIDDEN_PUBLISHED_ASSET_FIELDS = [
  "candidateLedger",
  "relationHints",
  "privateDraft",
  "publishStatus",
] as const;
export type ForbiddenPublishedAssetField =
  (typeof FORBIDDEN_PUBLISHED_ASSET_FIELDS)[number];

// ─── Zod schema（strict：拒绝 unknown/forbidden 字段）─────────────────────

export const publishedLearningAssetContractSchema = z
  .object({
    contractVersion: z.literal(PUBLISHED_LEARNING_ASSET_CONTRACT_VERSION),
    cardId: z.string().min(1),
    cardRevision: z.number().int().positive(),
    keyPointId: z.string().min(1),
    claim: z.string().min(1),
    exactEvidenceRefs: z.array(z.string().min(1)).min(1),
    semanticSupportReportId: z.string().min(1),
    semanticSupportReportHash: z.string().min(1),
    sourceFingerprint: z.string().min(1),
    lifecycle: z.enum(PUBLISHED_LEARNING_ASSET_LIFECYCLES),
    cognitiveType: z.string().min(1).optional(),
    interactionAffordances: z.array(z.string().min(1)).optional(),
  })
  .strict();

export type PublishedLearningAssetContractV1 = z.infer<
  typeof publishedLearningAssetContractSchema
>;

// ─── forbidden 字段负向校验（00-3 §6.3）───────────────────────────────────

/**
 * 负向校验：返回输入中命中的 forbidden 字段名列表（空数组 = 通过）。
 * 仅检查字段名存在性，不做类型判断，作为集成 Gate 的可测边界。
 */
export function validateForbiddenFields(
  input: Record<string, unknown>,
): ForbiddenPublishedAssetField[] {
  const hits: ForbiddenPublishedAssetField[] = [];
  for (const field of FORBIDDEN_PUBLISHED_ASSET_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(input, field)) {
      hits.push(field);
    }
  }
  return hits;
}

// ─── contract hash（集成 Gate 第一项）────────────────────────────────────

/**
 * 稳定化 JSON 序列化：对象键按字典序排序（递归）、数组保持顺序、
 * 值为 undefined 的属性跳过。使同一契约的键序差异不改变 hash。
 */
export function stableStringifyPublishedAsset(value: unknown): string {
  if (value === null || value === undefined || typeof value !== "object") {
    // 与 JSON.stringify 一致：数组元素中的 undefined 序列化为 null
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringifyPublishedAsset(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const pairs: string[] = [];
  for (const key of Object.keys(obj).sort()) {
    const v = obj[key];
    if (v === undefined) continue;
    pairs.push(`${JSON.stringify(key)}:${stableStringifyPublishedAsset(v)}`);
  }
  return `{${pairs.join(",")}}`;
}

/** contract hash：稳定化序列化 → SHA-256 hex（00-3 §6.5 集成 Gate 第一项） */
export function hashPublishedLearningAsset(
  asset: PublishedLearningAssetContractV1,
): string {
  return createHash("sha256")
    .update(stableStringifyPublishedAsset(asset), "utf8")
    .digest("hex");
}

// ─── 解析入口（required + forbidden 双向校验，失败抛错）────────────────────

/**
 * 解析并强制校验契约：先做 forbidden-field 负向（清晰错误信息），
 * 再由 strict schema 校验 required/optional/unknown。任何失败即抛错（fail closed）。
 */
export function parsePublishedLearningAsset(
  input: unknown,
): PublishedLearningAssetContractV1 {
  if (typeof input !== "object" || input === null) {
    throw new PublishedLearningAssetContractError(
      "PublishedLearningAssetContractV1 必须是对象",
      "invalid_input",
    );
  }
  const forbidden = validateForbiddenFields(input as Record<string, unknown>);
  if (forbidden.length > 0) {
    throw new PublishedLearningAssetContractError(
      `forbidden 字段存在（00-3 §6.3）: ${forbidden.join(", ")}`,
      "forbidden_fields_present",
    );
  }
  return publishedLearningAssetContractSchema.parse(input);
}

/** 契约/负向校验错误（fail closed 的统一错误类型） */
export class PublishedLearningAssetContractError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "PublishedLearningAssetContractError";
    this.code = code;
  }
}
